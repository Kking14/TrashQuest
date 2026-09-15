"""TrashQuest ESP32, YOLO, backend, and kiosk bridge.

Serial messages are newline-delimited JSON. Camera batches are accepted only
after stable per-box classification inside the configured platform ROI.
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import threading
import time
import uuid
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

try:
    from dotenv import load_dotenv
except ImportError:  # Pure unit tests do not need the optional station packages.
    def load_dotenv(*_args, **_kwargs):
        return False

from station_detection import BatchCoordinator, Detection, PlatformClearTracker, StableBatchDetector


ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env.station")


def env_bool(name: str, fallback: bool = False) -> bool:
    return os.getenv(name, str(fallback)).strip().lower() in {"1", "true", "yes", "on"}


def parse_roi(value: str) -> tuple[float, float, float, float]:
    try:
        roi = tuple(float(part.strip()) for part in value.split(","))
    except ValueError as error:
        raise ValueError("TQ_PLATFORM_ROI must contain four comma-separated decimals") from error
    if len(roi) != 4 or not (0 <= roi[0] < roi[2] <= 1 and 0 <= roi[1] < roi[3] <= 1):
        raise ValueError("TQ_PLATFORM_ROI must be normalized x1,y1,x2,y2 within 0..1")
    return roi


MODEL_PATH = Path(os.getenv("TQ_MODEL_PATH", "paper detection/best.pt"))
if not MODEL_PATH.is_absolute():
    MODEL_PATH = ROOT / MODEL_PATH
SERIAL_PORT = os.getenv("TQ_SERIAL_PORT", "COM3")
BAUD_RATE = int(os.getenv("TQ_BAUD_RATE", "115200"))
CAMERA_INDEX = int(os.getenv("TQ_CAMERA_INDEX", "0"))
CONFIDENCE = float(os.getenv("TQ_DETECTION_CONFIDENCE", os.getenv("TQ_CONFIDENCE", "0.63")))
PLATFORM_ROI = parse_roi(os.getenv("TQ_PLATFORM_ROI", "0.15,0.18,0.85,0.88"))
STABILITY_SECONDS = float(os.getenv("TQ_COUNT_STABILITY_SECONDS", "1.5"))
EMPTY_REARM_SECONDS = float(os.getenv("TQ_PLATFORM_EMPTY_SECONDS", "1.2"))
CONFIRMATION_TIMEOUT = float(os.getenv("TQ_CONFIRMATION_TIMEOUT_SECONDS", "120"))
SORT_TIMEOUT = float(os.getenv("TQ_SORT_TIMEOUT_SECONDS", "30"))
HTTP_TIMEOUT = float(os.getenv("TQ_HTTP_TIMEOUT_SECONDS", "8"))
BACKEND_URL = os.getenv("TQ_BACKEND_URL", "http://127.0.0.1:5001").rstrip("/")
DEVICE_KEY = os.getenv("TQ_DEVICE_KEY", "")
LOCAL_PORT = int(os.getenv("TQ_GATEWAY_PORT", "8765"))
PREVIEW_FPS = float(os.getenv("TQ_PREVIEW_FPS", "8"))
JPEG_QUALITY = int(os.getenv("TQ_JPEG_QUALITY", "80"))
SIMULATION_MODE = env_bool("TQ_SIMULATION_MODE")
SIMULATION_USE_BACKEND = env_bool("TQ_SIMULATION_USE_BACKEND")

# Production rates are loaded from the authenticated backend endpoint so the
# backend remains the one authoritative configuration location.
POINTS_PER_ITEM: dict[str, float] = {}
SIMULATION_POINT_RATES = {"Paper": 1, "Plastic": 2, "Tin Can": 2}
DEFAULT_ESTIMATED_GRAMS = {"Paper": 80, "Plastic": 45, "Tin Can": 25}
DEFAULT_CLASS_MAP = {
    "PAPER": "Paper", "CARDBOARD": "Paper",
    "PLASTIC": "Plastic", "PLASTIC BOTTLE": "Plastic",
    "PLASTIC_BOTTLE": "Plastic",
}
try:
    configured_map = json.loads(os.getenv("TQ_YOLO_CLASS_MAP", "{}"))
except json.JSONDecodeError as error:
    raise ValueError("TQ_YOLO_CLASS_MAP must be valid JSON") from error
CLASS_MAP = {**DEFAULT_CLASS_MAP, **{str(key).upper(): value for key, value in configured_map.items()}}
SUPPORTED_WASTE_TYPES = {"Paper", "Plastic", "Tin Can"}

events = deque(maxlen=200)
events_lock = threading.Lock()
workflow_events: queue.Queue[dict] = queue.Queue(maxsize=100)
backend_jobs: queue.Queue[dict] = queue.Queue(maxsize=50)
sequence = 0
station_status = {
    "online": False, "serial": False, "camera": False,
    "simulation": SIMULATION_MODE, "workflowState": "IDLE",
    "binFull": False, "platformClear": False, "activeSource": None, "lastError": None,
}
frame_lock = threading.Condition()
latest_jpeg: bytes | None = None
vision_sequence = 0
pending_confirmations: dict[str, queue.Queue[bool]] = {}
confirmation_lock = threading.Lock()
coordinator = BatchCoordinator()


def publish(event: dict) -> None:
    global sequence
    with events_lock:
        sequence += 1
        events.append({"sequence": sequence, "timestamp": time.time(), **event})


def set_workflow(state: str, error: str | None = None) -> None:
    station_status["workflowState"] = state
    if error is not None:
        station_status["lastError"] = error
    publish({"type": "status", "state": state, **({"message": error} if error else {})})


def backend_claim(batch: dict) -> dict:
    if SIMULATION_MODE and not SIMULATION_USE_BACKEND:
        return {
            "claimToken": f"trashquest-simulation:{batch['detectionId']}",
            "expiresAt": time.time() + 180,
            "pointsAvailable": round(SIMULATION_POINT_RATES[batch["wasteType"]] * batch["itemCount"]),
            "itemCount": batch["itemCount"], "duplicate": False,
        }
    if not DEVICE_KEY:
        raise RuntimeError("TQ_DEVICE_KEY is not configured")
    payload = json.dumps({
        "wasteType": batch["wasteType"], "itemCount": batch["itemCount"],
        "detectionId": batch["detectionId"], "confidence": batch.get("confidence"),
        "source": batch.get("source", "ai_camera"),
        "estimatedGrams": DEFAULT_ESTIMATED_GRAMS.get(batch["wasteType"]),
    }).encode()
    request = Request(
        f"{BACKEND_URL}/api/disposals/claims", data=payload, method="POST",
        headers={"Content-Type": "application/json", "X-Device-Key": DEVICE_KEY},
    )
    try:
        with urlopen(request, timeout=HTTP_TIMEOUT) as response:
            return json.load(response)["data"]
    except HTTPError as error:
        detail = error.read().decode(errors="replace")
        raise RuntimeError(f"Backend returned HTTP {error.code}: {detail}") from error
    except URLError as error:
        raise RuntimeError(f"Backend is unavailable: {error.reason}") from error


def load_point_rates() -> None:
    if SIMULATION_MODE and not SIMULATION_USE_BACKEND:
        POINTS_PER_ITEM.update(SIMULATION_POINT_RATES)
        return
    if not DEVICE_KEY:
        raise RuntimeError("TQ_DEVICE_KEY is required to load per-item point rates")
    request = Request(
        f"{BACKEND_URL}/api/disposals/point-rates",
        headers={"X-Device-Key": DEVICE_KEY},
    )
    try:
        with urlopen(request, timeout=HTTP_TIMEOUT) as response:
            rates = json.load(response)["data"]
    except (HTTPError, URLError, KeyError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Could not load point rates from backend: {error}") from error
    for waste_type in SUPPORTED_WASTE_TYPES:
        rate = rates.get(waste_type)
        if not isinstance(rate, (int, float)) or rate < 0:
            raise RuntimeError(f"Backend returned an invalid {waste_type} point rate")
    POINTS_PER_ITEM.update(rates)


def report_fullness(job: dict) -> None:
    if not DEVICE_KEY:
        raise RuntimeError("TQ_DEVICE_KEY is not configured")
    request = Request(
        f"{BACKEND_URL}/api/bins/sensor/full-status",
        data=json.dumps({"isFull": job["isFull"]}).encode(), method="PUT",
        headers={"Content-Type": "application/json", "X-Device-Key": DEVICE_KEY},
    )
    with urlopen(request, timeout=HTTP_TIMEOUT) as response:
        result = json.load(response)["data"]
    station_status.update(binFull=job["isFull"], fullnessDistanceCm=job.get("distanceCm"), lastFullnessReportAt=time.time())
    publish({"type": "bin_fullness", **job, "bin": result})


def backend_worker() -> None:
    while True:
        job = backend_jobs.get()
        try:
            if job["kind"] == "claim":
                batch = job["batch"]
                claim = backend_claim(batch)
                publish({"type": "item_sorted", **batch, **claim})
            elif job["kind"] == "fullness":
                report_fullness(job)
        except Exception as error:
            station_status["lastError"] = str(error)
            publish({"type": "error", "detectionId": job.get("batch", {}).get("detectionId"), "message": str(error)})
        finally:
            backend_jobs.task_done()


class GatewayHandler(BaseHTTPRequestHandler):
    def _json(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _read_json(self) -> dict:
        length = min(int(self.headers.get("Content-Length", "0")), 8192)
        return json.loads(self.rfile.read(length) or b"{}")

    def do_GET(self) -> None:
        path, _, query = self.path.partition("?")
        if path == "/health":
            self._json(200, station_status)
            return
        if path == "/events":
            after = 0
            for part in query.split("&"):
                if part.startswith("after="):
                    try: after = int(part[6:])
                    except ValueError: pass
            with events_lock:
                result = [item for item in events if item["sequence"] > after]
                latest_sequence = sequence
            self._json(200, {"events": result, "latestSequence": latest_sequence})
            return
        if path == "/camera.mjpg":
            self.send_response(200)
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            last_sequence = -1
            try:
                while True:
                    with frame_lock:
                        frame_lock.wait_for(lambda: vision_sequence != last_sequence, timeout=2)
                        image = latest_jpeg
                        last_sequence = vision_sequence
                    if not image:
                        time.sleep(0.1)
                        continue
                    self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\n")
                    self.wfile.write(f"Content-Length: {len(image)}\r\n\r\n".encode())
                    self.wfile.write(image + b"\r\n")
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        self._json(404, {"message": "Not found"})

    def do_OPTIONS(self) -> None:
        self._json(204, {})

    def do_POST(self) -> None:
        try:
            body = self._read_json()
            if self.path == "/confirm":
                detection_id = str(body.get("detectionId") or "")
                accepted = body.get("accepted")
                with confirmation_lock:
                    confirmation = pending_confirmations.get(detection_id)
                if not detection_id or not isinstance(accepted, bool):
                    self._json(400, {"message": "detectionId and boolean accepted are required"})
                elif confirmation is None:
                    self._json(404, {"message": "Detection is no longer waiting for confirmation"})
                else:
                    try: confirmation.put_nowait(accepted)
                    except queue.Full: pass
                    self._json(202, {"success": True, "accepted": accepted})
                return
            if self.path == "/simulate" and SIMULATION_MODE:
                if body.get("platformEmpty") is True:
                    workflow_events.put_nowait({"event": "platform_empty"})
                    self._json(202, {"success": True})
                    return
                waste_type = str(body.get("wasteType") or "")
                item_count = int(body.get("itemCount") or 1)
                if waste_type not in SUPPORTED_WASTE_TYPES or not 1 <= item_count <= 100:
                    self._json(400, {"message": "Invalid simulation batch"})
                    return
                workflow_events.put_nowait({
                    "event": "camera_batch", "detectionId": f"simulation-{uuid.uuid4()}",
                    "wasteType": waste_type, "itemCount": item_count,
                    "confidence": float(body.get("confidence") or 0.9), "source": "simulation",
                })
                self._json(202, {"success": True})
                return
            self._json(404, {"message": "Not found"})
        except (ValueError, json.JSONDecodeError, queue.Full):
            self._json(400, {"message": "Invalid request"})

    def log_message(self, *_args) -> None:
        return


class GatewayServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def run_local_api() -> None:
    GatewayServer(("127.0.0.1", LOCAL_PORT), GatewayHandler).serve_forever()


def serial_reader(device) -> None:
    while True:
        try:
            raw = device.readline()
            if not raw: continue
            if len(raw) > 2048:
                publish({"type": "error", "message": "Oversized serial message ignored"})
                continue
            line = raw.decode(errors="replace").strip()
            if not line: continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                # Some USB serial adapters can prepend a damaged fragment to an
                # otherwise complete JSON object. Recover only a bounded object;
                # all other malformed input remains safely ignored.
                object_start = line.find("{")
                object_end = line.rfind("}")
                if object_start < 0 or object_end <= object_start:
                    raise
                message = json.loads(line[object_start:object_end + 1])
            if not isinstance(message, dict): continue
            if message.get("event") == "bin_fullness":
                station_status["binFull"] = bool(message.get("isFull"))
                try: backend_jobs.put_nowait({"kind": "fullness", **message})
                except queue.Full: publish({"type": "error", "message": "Fullness report queue is busy"})
                continue
            workflow_events.put(message, timeout=0.2)
            print("ESP32 ->", message)
        except json.JSONDecodeError:
            publish({"type": "serial_warning", "message": "Malformed serial JSON ignored"})
        except queue.Full:
            publish({"type": "serial_warning", "message": "Busy; additional sensor event ignored"})
        except Exception as error:
            station_status.update(serial=False, online=False, lastError=str(error))
            return


class SimulationSerial:
    def write(self, data: bytes) -> int:
        message = json.loads(data.decode().strip())
        detection_id = message.get("detectionId")
        command = message.get("command")
        if command == "prepare":
            workflow_events.put({"event": "prepared", "detectionId": detection_id, "success": True})
        elif command == "sort":
            threading.Timer(0.25, lambda: workflow_events.put({"event": "sorted", "detectionId": detection_id, "success": True})).start()
        elif command in {"reject", "recover", "platform_empty"}:
            workflow_events.put({"event": "ready", "detectionId": detection_id, "success": True})
        return len(data)

    def flush(self) -> None: pass
    def close(self) -> None: pass


def send(device, message: dict) -> None:
    device.write((json.dumps(message, separators=(",", ":")) + "\n").encode())
    device.flush()
    print("ESP32 <-", message)


def wait_for_event(detection_id: str, event_name: str, timeout: float) -> dict | None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            message = workflow_events.get(timeout=min(0.25, max(0.01, deadline - time.monotonic())))
        except queue.Empty:
            continue
        if message.get("event") == "inductive_detected":
            station_status["lastInductiveDetectionAt"] = time.time()
            publish({"type": "inductive_confirmation", **message})
            continue
        if message.get("event") == event_name and message.get("detectionId") == detection_id:
            return message
        if message.get("detectionId") and message.get("detectionId") != detection_id:
            publish({"type": "busy", "detectionId": message.get("detectionId"), "message": "Station is processing another batch"})
    return None


def normalize_class(name: str) -> str | None:
    result = CLASS_MAP.get(name.strip().upper())
    return result if result in SUPPORTED_WASTE_TYPES else None


def batch_from_inductive(message: dict) -> dict:
    """Create one tin-can batch without consulting the AI model."""
    return {
        "event": "inductive_batch",
        "detectionId": str(message.get("detectionId") or f"inductive-{uuid.uuid4()}"),
        "wasteType": "Tin Can",
        "itemCount": 1,
        "confidence": 1.0,
        "source": "inductive_sensor",
    }


def vision_loop(model, camera) -> None:
    import cv2
    global latest_jpeg, vision_sequence
    detector = StableBatchDetector(
        roi=PLATFORM_ROI, minimum_confidence=CONFIDENCE,
        stability_seconds=STABILITY_SECONDS, empty_seconds=EMPTY_REARM_SECONDS,
    )
    clear_tracker = PlatformClearTracker(EMPTY_REARM_SECONDS)
    previous = time.perf_counter()
    while True:
        ok, frame = camera.read()
        if not ok:
            station_status.update(camera=False, lastError="Camera frame could not be read")
            time.sleep(0.2)
            continue
        height, width = frame.shape[:2]
        result = model.predict(frame, conf=max(0.05, CONFIDENCE * 0.75), verbose=False)[0]
        accepted_detections = []
        display_detections = []
        platform_has_object = False
        for model_box in result.boxes:
            class_id = int(model_box.cls[0])
            class_name = str(model.names[class_id])
            waste_type = normalize_class(class_name)
            confidence = float(model_box.conf[0])
            x1, y1, x2, y2 = map(float, model_box.xyxy[0])
            normalized_box = (x1 / width, y1 / height, x2 / width, y2 / height)
            if waste_type:
                accepted_detections.append(Detection(waste_type, confidence, normalized_box))
            in_roi = PLATFORM_ROI[0] <= (x1 + x2) / (2 * width) <= PLATFORM_ROI[2] and PLATFORM_ROI[1] <= (y1 + y2) / (2 * height) <= PLATFORM_ROI[3]
            if waste_type and in_roi and confidence >= CONFIDENCE:
                platform_has_object = True
            display_detections.append({"className": class_name, "wasteType": waste_type, "confidence": confidence, "inPlatformRoi": in_roi})
            color = (66, 214, 137) if waste_type and in_roi else (120, 120, 120)
            cv2.rectangle(frame, (int(x1), int(y1)), (int(x2), int(y2)), color, 2)
            cv2.putText(frame, f"{class_name} {confidence:.0%}", (int(x1), max(18, int(y1) - 7)), cv2.FONT_HERSHEY_SIMPLEX, 0.55, color, 2)

        rx1, ry1, rx2, ry2 = PLATFORM_ROI
        cv2.rectangle(frame, (int(rx1 * width), int(ry1 * height)), (int(rx2 * width), int(ry2 * height)), (40, 220, 240), 2)
        cv2.putText(frame, "PLATFORM ROI", (int(rx1 * width), max(20, int(ry1 * height) - 8)), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (40, 220, 240), 2)
        monotonic_now = time.monotonic()
        stable = detector.update(accepted_detections, monotonic_now)
        if stable and stable.status == "accepted":
            workflow_events.put({
                "event": "camera_batch", "detectionId": f"camera-{uuid.uuid4()}",
                "wasteType": stable.waste_type, "itemCount": stable.item_count,
                "confidence": stable.confidence, "source": "ai_camera",
            })
        elif stable and stable.status == "mixed":
            publish({"type": "mixed_waste_rejected", "wasteTypes": stable.waste_types, "message": "Mixed waste detected. Remove all items and place one waste type at a time."})
        elif stable and stable.status == "rearmed":
            workflow_events.put({"event": "platform_empty"})

        active_detection_id = coordinator.active_detection_id
        platform_clear, should_signal_empty = clear_tracker.update(
            has_object=platform_has_object,
            now=monotonic_now,
            active_detection_id=active_detection_id,
            waiting_for_empty=(
                station_status.get("workflowState") == "WAITING_FOR_PLATFORM_EMPTY"
                and station_status.get("activeSource") != "inductive_sensor"
            ),
        )
        if should_signal_empty:
            workflow_events.put({"event": "platform_empty", "detectionId": active_detection_id, "source": "camera_clear"})

        now = time.perf_counter()
        fps = 1 / max(now - previous, 0.001)
        previous = now
        encoded, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
        if encoded:
            with frame_lock:
                latest_jpeg = jpeg.tobytes()
                vision_sequence += 1
                frame_lock.notify_all()
        station_status.update(
            camera=True, visionFps=round(fps, 1), detections=display_detections,
            scanning=bool(accepted_detections) and not detector.locked,
            platformClear=platform_clear,
            lastFrameAt=time.time(),
        )
        elapsed = time.perf_counter() - now
        time.sleep(max(0, (1 / max(PREVIEW_FPS, 1)) - elapsed))


def handle_batch(device, batch: dict) -> None:
    detection_id = str(batch["detectionId"])
    if station_status.get("binFull"):
        if batch.get("source") == "inductive_sensor":
            send(device, {"command": "recover", "detectionId": detection_id})
        publish({"type": "rejected", "detectionId": detection_id, "message": "Bin is full and needs collection."})
        return
    if not coordinator.begin(detection_id):
        publish({"type": "busy", "detectionId": detection_id, "message": "Another batch is active"})
        return
    station_status["activeSource"] = batch.get("source", "ai_camera")
    item_count = max(1, int(batch.get("itemCount") or 1))
    batch.update(itemCount=item_count, confidence=round(float(batch.get("confidence") or 0), 3))
    set_workflow("WAITING_FOR_CONFIRMATION")
    send(device, {"command": "prepare", "detectionId": detection_id, "wasteType": batch["wasteType"], "itemCount": item_count, "source": batch.get("source", "ai_camera")})
    publish({"type": "item_detected", **batch, "pointsAvailable": round(POINTS_PER_ITEM[batch["wasteType"]] * item_count)})

    confirmation = queue.Queue(maxsize=1)
    with confirmation_lock: pending_confirmations[detection_id] = confirmation
    try:
        accepted = confirmation.get(timeout=CONFIRMATION_TIMEOUT)
    except queue.Empty:
        accepted = False
        publish({"type": "error", "detectionId": detection_id, "message": "Confirmation timed out. Remove the batch."})
    finally:
        with confirmation_lock: pending_confirmations.pop(detection_id, None)

    if not accepted:
        send(device, {"command": "reject", "detectionId": detection_id})
        publish({"type": "detection_cancelled", "detectionId": detection_id})
        set_workflow("WAITING_FOR_PLATFORM_EMPTY")
        return

    set_workflow("SORTING")
    send(device, {
        "command": "sort", "detectionId": detection_id, "wasteType": batch["wasteType"],
        "itemCount": item_count, "confidence": batch["confidence"],
        "source": batch.get("source", "ai_camera"),
    })
    result = wait_for_event(detection_id, "sorted", SORT_TIMEOUT)
    if not result or not result.get("success"):
        message = "ESP32 sorting failed or timed out; no claim was created."
        publish({"type": "error", "detectionId": detection_id, "message": message})
        send(device, {"command": "recover", "detectionId": detection_id})
        coordinator.clear()
        set_workflow("ERROR_RECOVERY", message)
        set_workflow("IDLE")
        return
    publish({"type": "sorting_successful", **batch})
    backend_jobs.put({"kind": "claim", "batch": dict(batch)})
    set_workflow("WAITING_FOR_PLATFORM_EMPTY")
    if SIMULATION_MODE:
        threading.Timer(0.75, lambda: workflow_events.put({"event": "platform_empty"})).start()


def workflow_loop(device) -> None:
    while station_status["serial"]:
        try: message = workflow_events.get(timeout=0.5)
        except queue.Empty: continue
        event_name = message.get("event")
        if event_name == "camera_batch":
            handle_batch(device, message)
        elif event_name == "platform_empty":
            active_id = coordinator.active_detection_id
            if active_id:
                send(device, {"command": "platform_empty", "detectionId": active_id})
                publish({"type": "platform_empty", "detectionId": active_id})
                coordinator.clear()
                station_status["activeSource"] = None
            set_workflow("IDLE")
        elif event_name == "inductive_detected":
            station_status["lastInductiveDetectionAt"] = time.time()
            publish({"type": "inductive_confirmation", **message})
            handle_batch(device, batch_from_inductive(message))
        elif event_name in {"timeout", "error"}:
            publish({"type": "error", "detectionId": message.get("detectionId"), "message": message.get("message", "ESP32 error")})
            coordinator.clear()
            set_workflow("IDLE")


def main(simulate: bool = False) -> None:
    global SIMULATION_MODE
    SIMULATION_MODE = simulate or SIMULATION_MODE
    station_status["simulation"] = SIMULATION_MODE
    load_point_rates()
    threading.Thread(target=run_local_api, daemon=True).start()
    threading.Thread(target=backend_worker, daemon=True).start()
    camera = None
    device = None
    try:
        if SIMULATION_MODE:
            device = SimulationSerial()
            station_status.update(online=True, serial=True, camera=True, lastError=None)
        else:
            import cv2
            import serial
            from ultralytics import YOLO
            if not MODEL_PATH.exists():
                raise FileNotFoundError(f"YOLO model not found: {MODEL_PATH}")
            model = YOLO(str(MODEL_PATH))
            camera = cv2.VideoCapture(CAMERA_INDEX, cv2.CAP_DSHOW)
            if not camera.isOpened():
                camera.release()
                camera = cv2.VideoCapture(CAMERA_INDEX)
            if not camera.isOpened():
                raise RuntimeError("Camera could not be opened")
            threading.Thread(target=vision_loop, args=(model, camera), daemon=True).start()
            device = serial.Serial(SERIAL_PORT, BAUD_RATE, timeout=0.25, write_timeout=1)
            time.sleep(2)
            station_status.update(online=True, serial=True, camera=True, lastError=None)
            threading.Thread(target=serial_reader, args=(device,), daemon=True).start()
        set_workflow("IDLE")
        print(f"Gateway ready ({'simulation' if SIMULATION_MODE else SERIAL_PORT}): http://127.0.0.1:{LOCAL_PORT}")
        workflow_loop(device)
    finally:
        station_status.update(online=False, serial=False)
        if camera is not None: camera.release()
        if device is not None: device.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--simulate", action="store_true", help="run without a camera or ESP32")
    arguments = parser.parse_args()
    try:
        main(arguments.simulate)
    except KeyboardInterrupt:
        pass
    except Exception as error:
        station_status.update(online=False, lastError=str(error))
        raise
