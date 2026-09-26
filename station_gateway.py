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

from station_detection import BatchCoordinator, Detection, MetalObjectMatcher, PlatformClearTracker, StableBatchDetector


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
MODEL_OPTIONS = {
    "current": ("Current YOLOv8s · PyTorch", MODEL_PATH),
    "yolov8s-onnx": ("YOLOv8s · ONNX", ROOT / "models/yolov8s/best.onnx"),
    "yolov8s-ncnn": ("YOLOv8s · NCNN", ROOT / "models/yolov8s/best_ncnn_model"),
    "yolo26n-pt": ("YOLO26n · PyTorch", ROOT / "models/yolo26n/best.pt"),
    "yolo26n-onnx": ("YOLO26n · ONNX", ROOT / "models/yolo26n/best.onnx"),
    "yolo26n-ncnn": ("YOLO26n · NCNN", ROOT / "models/yolo26n/best_ncnn_model"),
}
SERIAL_PORT = os.getenv("TQ_SERIAL_PORT", "COM3")
BAUD_RATE = int(os.getenv("TQ_BAUD_RATE", "115200"))
CAMERA_INDEX = int(os.getenv("TQ_CAMERA_INDEX", "0"))
CONFIDENCE = float(os.getenv("TQ_DETECTION_CONFIDENCE", os.getenv("TQ_CONFIDENCE", "0.63")))
PLATFORM_ROI = parse_roi(os.getenv("TQ_PLATFORM_ROI", "0.15,0.18,0.85,0.88"))
INDUCTIVE_ROI = parse_roi(os.getenv("TQ_INDUCTIVE_ROI", "0.53,0.41,0.59,0.49"))
STABILITY_SECONDS = float(os.getenv("TQ_COUNT_STABILITY_SECONDS", "1.5"))
EMPTY_REARM_SECONDS = float(os.getenv("TQ_PLATFORM_EMPTY_SECONDS", "1.2"))
SORT_TIMEOUT = float(os.getenv("TQ_SORT_TIMEOUT_SECONDS", "30"))
HTTP_TIMEOUT = float(os.getenv("TQ_HTTP_TIMEOUT_SECONDS", "8"))
BACKEND_URL = os.getenv("TQ_BACKEND_URL", "http://127.0.0.1:5001").rstrip("/")
DEVICE_KEY = os.getenv("TQ_DEVICE_KEY", "")
LOCAL_PORT = int(os.getenv("TQ_GATEWAY_PORT", "8765"))
PREVIEW_FPS = float(os.getenv("TQ_PREVIEW_FPS", "20"))
JPEG_QUALITY = int(os.getenv("TQ_JPEG_QUALITY", "80"))
SIMULATION_MODE = env_bool("TQ_SIMULATION_MODE")
SIMULATION_USE_BACKEND = env_bool("TQ_SIMULATION_USE_BACKEND")

# Production rates are loaded from the authenticated backend endpoint so the
# backend remains the one authoritative configuration location.
POINTS_PER_ITEM: dict[str, float] = {}
SIMULATION_POINT_RATES = {"Paper": 5, "Plastic": 10, "Tin Can": 15}
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
    "acceptingItems": True, "binFull": False, "platformClear": False, "activeSource": None, "lastError": None,
    "activeModel": "current", "modelSwitching": False,
    "manualRecoveryRequired": False,
    "binCompartments": {}, "metalCheckReady": False,
}
model_lock = threading.Lock()
active_model = None
active_model_key = "current"
model_generation = 0
model_switching = False
MIXED_WASTE_MESSAGE = "Two different waste types detected. Please put only one waste type at a time. Remove all items to try again."
sensor_interlock_lock = threading.RLock()
sensor_clear_since = None
metal_matcher = MetalObjectMatcher(INDUCTIVE_ROI)


def update_sensor_interlock(*, metal=None, ai_visible=None):
    """Latch simultaneous metal/camera detections until both sensors stay clear."""
    global sensor_clear_since
    with sensor_interlock_lock:
        metal_sort_committed = (station_status.get("activeSource") == "inductive_sensor"
                                and station_status.get("workflowState") == "SORTING")
        if metal is not None:
            if metal and not station_status.get("inductiveActive", False):
                station_status["metalSignalAt"] = time.monotonic()
                station_status["metalCheckReady"] = False
                # The old AI box may be the can itself. Re-evaluate a fresh
                # frame against the sensor position before calling it mixed.
                station_status["aiWasteVisible"] = False
            station_status["inductiveActive"] = bool(metal)
        if metal_sort_committed:
            # The camera cannot identify a rolling can reliably after the
            # motor starts. Mixed waste was checked before committing the sort.
            station_status["aiWasteVisible"] = False
        elif ai_visible is not None:
            station_status["aiWasteVisible"] = bool(ai_visible)
        metal_active = station_status.get("inductiveActive", False)
        camera_active = station_status.get("aiWasteVisible", False)
        ai_sort_active = (station_status.get("activeSource") == "ai_camera"
                          and station_status.get("workflowState") in {"PREPARING", "SORTING"})
        metal_sort_active = (station_status.get("activeSource") == "inductive_sensor"
                            and station_status.get("workflowState") in {"PREPARING", "SORTING"})
        if (metal_active and (camera_active or ai_sort_active)) or (camera_active and metal_sort_active):
            if not station_status.get("sensorMixedBlocked"):
                publish({"type": "mixed_waste_rejected", "message": MIXED_WASTE_MESSAGE})
            station_status["sensorMixedBlocked"] = True
        if metal_active or camera_active:
            sensor_clear_since = None
        elif station_status.get("sensorMixedBlocked"):
            if sensor_clear_since is None:
                sensor_clear_since = time.monotonic()
            elif time.monotonic() - sensor_clear_since >= EMPTY_REARM_SECONDS:
                station_status["sensorMixedBlocked"] = False
                publish({"type": "mixed_waste_cleared"})
        return station_status.get("sensorMixedBlocked", False)


def mixed_waste_blocked():
    return station_status.get("mixedWasteBlocked", False) or station_status.get("sensorMixedBlocked", False)


def associate_metal(detections, captured_at):
    with sensor_interlock_lock:
        if (station_status.get("activeSource") == "inductive_sensor"
                and station_status.get("workflowState") == "SORTING"):
            # Treat all camera boxes during motion as untrusted. A can can roll
            # out of its original box and be relabeled plastic or paper.
            update_sensor_interlock(ai_visible=False)
            station_status["metalCheckReady"] = True
            return [], None, False, True
        metal_active = station_status.get("inductiveActive", False)
        transaction_active = (station_status.get("activeSource") == "inductive_sensor"
                              and station_status.get("workflowState") in
                              {"PREPARING", "SORTING", "WAITING_FOR_PLATFORM_EMPTY", "ERROR_RECOVERY"})
        visible = [item for item in detections if item.confidence >= max(0.05, CONFIDENCE * 0.75)
                   and PLATFORM_ROI[0] <= (item.box[0] + item.box[2]) / 2 <= PLATFORM_ROI[2]
                   and PLATFORM_ROI[1] <= (item.box[1] + item.box[3]) / 2 <= PLATFORM_ROI[3]]
        if metal_active and captured_at <= station_status.get("metalSignalAt", 0):
            return [], None, True, True
        remaining, matched, pending = metal_matcher.update(
            visible, metal_active=metal_active, transaction_active=transaction_active, now=captured_at)
        # Additional boxes always count, even while the matched box stabilizes.
        update_sensor_interlock(ai_visible=bool(remaining))
        station_status["metalCheckReady"] = not pending
        station_status["metalMatched"] = matched is not None
        return remaining, matched, pending, metal_active or transaction_active


def update_camera_stability(detector, detections, captured_at):
    """Keep the accepted camera batch fixed while the mechanism is moving."""
    with sensor_interlock_lock:
        if station_status.get("workflowState") == "SORTING":
            # Motion can make one paper item briefly look like plastic (or
            # split it into two boxes). Validate mixed waste before motion.
            return None
        stable = detector.update(detections, captured_at)
        station_status["mixedWasteBlocked"] = detector.mixed_blocked
        return stable


def record_fullness(message):
    """Apply sensor data immediately; backend HTTP latency cannot clear a newer reading."""
    bin_type = message.get("binType", "plastic")
    if bin_type not in {"plastic", "metal"} or not isinstance(message.get("isFull"), bool):
        return False
    previous = station_status["binCompartments"].get(bin_type, {})
    valid = message.get("readingValid", True) is True
    reading = {"isFull": message["isFull"] if valid else bool(previous.get("isFull") or message["isFull"]),
               "readingValid": valid, "distanceCm": message.get("distanceCm") if valid else None,
               "updatedAt": time.time()}
    station_status["binCompartments"][bin_type] = reading
    station_status["binFull"] = any(item["isFull"] for item in station_status["binCompartments"].values())
    publish({"type": "bin_fullness", "binType": bin_type, **reading})
    return True


frame_lock = threading.Condition()
latest_jpeg: bytes | None = None
vision_sequence = 0
camera_frames = queue.Queue(maxsize=1)
camera_stop = threading.Event()
preview_annotations = (0.0, [])
coordinator = BatchCoordinator()
ignored_detection_ids = deque(maxlen=200)


def publish(event: dict) -> None:
    global sequence
    with events_lock:
        sequence += 1
        events.append({"sequence": sequence, "timestamp": time.time(), **event})


def set_workflow(state: str, error: str | None = None) -> None:
    if station_status.get("manualRecoveryRequired"):
        state = "ERROR_RECOVERY"
        error = station_status.get("lastError")
    station_status["workflowState"] = state
    if error is not None:
        station_status["lastError"] = error
    publish({"type": "status", "state": state, **({"message": error} if error else {})})


def handle_controller_recovery(message: dict) -> bool:
    """Keep a physical recovery lock until the ESP32 reports a fresh boot."""
    if message.get("requiresManualReset"):
        first_report = not station_status.get("manualRecoveryRequired")
        notice = message.get("message") or (
            "Sorting locked. Remove the waste, check the mechanism and return it home, "
            "then press ESP32 EN to restart."
        )
        station_status.update(manualRecoveryRequired=True, acceptingItems=False,
                              lastError=notice, scanning=False)
        set_workflow("ERROR_RECOVERY", notice)
        if first_report or message.get("event") == "error":
            publish({"type": "error", "detectionId": message.get("detectionId"), "message": notice})
        return True
    if message.get("event") == "ready" and station_status.get("manualRecoveryRequired"):
        coordinator.clear()
        station_status.update(manualRecoveryRequired=False, acceptingItems=True,
                              activeSource=None, lastError=None)
        set_workflow("IDLE")
        publish({"type": "recovery_cleared", "message": "Station restarted. Clear the platform before placing the next item."})
    return False


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
        data=json.dumps({"isFull": job["isFull"], "binType": job.get("binType", "plastic"),
                         "readingValid": job.get("readingValid", True), "distanceCm": job.get("distanceCm")}).encode(), method="PUT",
        headers={"Content-Type": "application/json", "X-Device-Key": DEVICE_KEY},
    )
    with urlopen(request, timeout=HTTP_TIMEOUT) as response:
        result = json.load(response)["data"]
    station_status["lastFullnessReportAt"] = time.time()
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
        if path == "/models":
            self._json(200, {"active": active_model_key, "switching": model_switching,
                             "options": [{"id": key, "label": label, "available": path.exists()}
                                         for key, (label, path) in MODEL_OPTIONS.items()]})
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
            if self.path == "/models/select":
                origin = self.headers.get("Origin")
                if origin and origin not in {"http://127.0.0.1:5173", "http://localhost:5173"}:
                    self._json(403, {"message": "Model selection is available only from the local station display."})
                    return
                try:
                    selected = select_model(body.get("id"))
                except KeyError:
                    self._json(400, {"message": "Unknown model."})
                    return
                except RuntimeError as error:
                    self._json(409, {"message": str(error)})
                    return
                except Exception as error:
                    self._json(422, {"message": f"Model could not be loaded: {error}"})
                    return
                self._json(200, {"active": selected, "message": "Model ready."})
                return
            if self.path == "/continue":
                if station_status.get("manualRecoveryRequired"):
                    self._json(409, {"message": station_status["lastError"]})
                elif coordinator.active_detection_id:
                    self._json(409, {"message": "Wait for the platform to clear before continuing."})
                else:
                    station_status["acceptingItems"] = True
                    self._json(202, {"success": True})
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
            if handle_controller_recovery(message):
                print("ESP32 ->", message)
                continue
            if message.get("event") == "inductive_state":
                update_sensor_interlock(metal=message.get("active", False))
                continue
            if message.get("event") == "inductive_detected":
                update_sensor_interlock(metal=True)
            if message.get("event") == "mixed_waste_detected":
                station_status["sensorMixedBlocked"] = True
                publish({"type": "mixed_waste_rejected", "message": MIXED_WASTE_MESSAGE})
                continue
            if message.get("event") == "bin_fullness":
                if record_fullness(message):
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
        if mixed_waste_blocked() or station_status.get("manualRecoveryRequired"):
            return None
        try:
            message = workflow_events.get(timeout=min(0.25, max(0.01, deadline - time.monotonic())))
        except queue.Empty:
            continue
        if message.get("event") == "inductive_detected":
            update_sensor_interlock(metal=True)
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
    return result if result in {"Paper", "Plastic"} else None


def select_model(key: str, loader=None) -> str:
    """Warm a candidate before swapping; a failed load leaves the live model intact."""
    global active_model, active_model_key, model_generation, model_switching
    if key not in MODEL_OPTIONS:
        raise KeyError(key)
    if not model_lock.acquire(blocking=False):
        raise RuntimeError("Another model change is already in progress.")
    try:
        if key == active_model_key:
            return key
        if (SIMULATION_MODE or active_model is None or not station_status.get("online")
                or station_status.get("workflowState") != "IDLE"
                or coordinator.active_detection_id or mixed_waste_blocked()
                or not station_status.get("platformClear")):
            raise RuntimeError("Wait until the station is idle and the platform is empty.")
        label, path = MODEL_OPTIONS[key]
        if not path.exists():
            raise FileNotFoundError(f"Model files are missing: {path}")
        import numpy as np
        if loader is None:
            from ultralytics import YOLO
            loader = YOLO

        model_switching = True
        station_status["modelSwitching"] = True
        was_accepting = station_status["acceptingItems"]
        station_status["acceptingItems"] = False
        try:
            candidate = loader(str(path))
            candidate.predict(np.zeros((640, 640, 3), dtype=np.uint8), imgsz=640,
                              conf=max(0.05, CONFIDENCE * 0.75), verbose=False)
            names = candidate.names.values() if isinstance(candidate.names, dict) else candidate.names
            if not {"Paper", "Plastic"}.issubset({normalize_class(str(name)) for name in names}):
                raise ValueError(f"{label} does not contain both paper and plastic classes")
            if (station_status.get("workflowState") != "IDLE"
                    or coordinator.active_detection_id or not station_status.get("platformClear")):
                raise RuntimeError("The platform changed while loading the model. Try again when empty.")
            active_model = candidate
            active_model_key = key
            model_generation += 1
            station_status["activeModel"] = key
            station_status["detections"] = []
            publish({"type": "model_changed", "model": key, "label": label})
            return key
        finally:
            station_status["acceptingItems"] = was_accepting
            station_status["modelSwitching"] = False
            model_switching = False
    finally:
        model_lock.release()


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


def offer_latest_frame(frame, captured_at):
    """Keep only the newest frame; slow inference must never block capture."""
    try:
        camera_frames.get_nowait()
    except queue.Empty:
        pass
    camera_frames.put_nowait((frame, captured_at))


def camera_preview_loop(camera) -> None:
    import cv2
    global latest_jpeg, vision_sequence
    previous = None
    while not camera_stop.is_set():
        started = time.monotonic()
        ok, frame = camera.read()
        if not ok:
            station_status.update(camera=False, platformClear=False, lastError="Camera frame could not be read")
            camera_stop.wait(0.2)
            continue
        captured_at = time.monotonic()
        offer_latest_frame(frame.copy(), captured_at)
        height, width = frame.shape[:2]
        annotated_at, annotations = preview_annotations
        # Boxes update at inference speed; expire them if inference stops.
        if captured_at - annotated_at < 1.0:
            for label, confidence, bounds, color in annotations:
                x1, y1, x2, y2 = bounds
                cv2.rectangle(frame, (int(x1 * width), int(y1 * height)), (int(x2 * width), int(y2 * height)), color, 2)
                cv2.putText(frame, f"{label} {confidence:.0%}", (int(x1 * width), max(18, int(y1 * height) - 7)), cv2.FONT_HERSHEY_SIMPLEX, 0.55, color, 2)
        rx1, ry1, rx2, ry2 = PLATFORM_ROI
        cv2.rectangle(frame, (int(rx1 * width), int(ry1 * height)), (int(rx2 * width), int(ry2 * height)), (40, 220, 240), 2)
        cv2.putText(frame, "PLATFORM ROI", (int(rx1 * width), max(20, int(ry1 * height) - 8)), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (40, 220, 240), 2)
        sx1, sy1, sx2, sy2 = INDUCTIVE_ROI
        cv2.rectangle(frame, (int(sx1 * width), int(sy1 * height)), (int(sx2 * width), int(sy2 * height)), (220, 80, 220), 2)
        cv2.putText(frame, "METAL SENSOR", (int(sx1 * width), max(16, int(sy1 * height) - 5)), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (220, 80, 220), 1)
        encoded, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
        if encoded:
            with frame_lock:
                latest_jpeg = jpeg.tobytes()
                vision_sequence += 1
                frame_lock.notify_all()
            now = time.monotonic()
            fps = 0 if previous is None else 1 / max(now - previous, 0.001)
            previous = now
            station_status.update(camera=True, previewFps=round(fps, 1), lastFrameAt=time.time())
        camera_stop.wait(max(0, 1 / max(PREVIEW_FPS, 1) - (time.monotonic() - started)))


def vision_loop(model) -> None:
    global preview_annotations
    detector = StableBatchDetector(
        roi=PLATFORM_ROI, minimum_confidence=CONFIDENCE,
        stability_seconds=STABILITY_SECONDS, empty_seconds=EMPTY_REARM_SECONDS,
    )
    clear_tracker = PlatformClearTracker(EMPTY_REARM_SECONDS)
    previous = time.perf_counter()
    seen_generation = model_generation
    while not camera_stop.is_set():
        try:
            frame, captured_at = camera_frames.get(timeout=0.25)
        except queue.Empty:
            continue
        if model_switching:
            continue
        if seen_generation != model_generation:
            detector = StableBatchDetector(
                roi=PLATFORM_ROI, minimum_confidence=CONFIDENCE,
                stability_seconds=STABILITY_SECONDS, empty_seconds=EMPTY_REARM_SECONDS,
            )
            clear_tracker = PlatformClearTracker(EMPTY_REARM_SECONDS)
            seen_generation = model_generation
        selected_model = active_model or model
        height, width = frame.shape[:2]
        result = selected_model.predict(frame, conf=max(0.05, CONFIDENCE * 0.75), verbose=False)[0]
        if model_switching or seen_generation != model_generation:
            continue
        accepted_detections = []
        display_detections = []
        annotations = []
        platform_has_object = False
        for model_box in result.boxes:
            class_id = int(model_box.cls[0])
            class_name = str(selected_model.names[class_id])
            waste_type = normalize_class(class_name)
            confidence = float(model_box.conf[0])
            x1, y1, x2, y2 = map(float, model_box.xyxy[0])
            normalized_box = (x1 / width, y1 / height, x2 / width, y2 / height)
            if waste_type:
                accepted_detections.append(Detection(waste_type, confidence, normalized_box))
            in_roi = PLATFORM_ROI[0] <= (x1 + x2) / (2 * width) <= PLATFORM_ROI[2] and PLATFORM_ROI[1] <= (y1 + y2) / (2 * height) <= PLATFORM_ROI[3]
            if waste_type and in_roi and confidence >= CONFIDENCE:
                platform_has_object = True
            display_detections.append({"className": class_name, "wasteType": waste_type, "confidence": confidence, "inPlatformRoi": in_roi, "box": normalized_box})
            color = (66, 214, 137) if waste_type and in_roi else (120, 120, 120)
            annotations.append((class_name, confidence, normalized_box, color))
        remaining, matched, pending, metal_context = associate_metal(accepted_detections, captured_at)
        if matched is not None:
            annotations = [("Metal (inductive)" if bounds == matched.box else label, conf, bounds,
                            (0, 190, 255) if bounds == matched.box else color)
                           for label, conf, bounds, color in annotations]
            for item in display_detections:
                if item.get("box") == matched.box:
                    item.update(wasteType="Tin Can", className="Metal detected via inductive sensor")
        preview_annotations = (captured_at, annotations)
        monotonic_now = captured_at
        stable = update_camera_stability(detector, remaining, monotonic_now)
        station_status["lastInferenceCapturedAt"] = captured_at
        if stable and stable.status == "accepted" and not mixed_waste_blocked() and not metal_context and not pending:
            workflow_events.put({
                "event": "camera_batch", "detectionId": f"camera-{uuid.uuid4()}",
                "wasteType": stable.waste_type, "itemCount": stable.item_count,
                "confidence": stable.confidence, "source": "ai_camera",
            })
        elif stable and stable.status == "mixed":
            publish({"type": "mixed_waste_rejected", "wasteTypes": stable.waste_types, "message": MIXED_WASTE_MESSAGE})
        elif stable and stable.status == "rearmed":
            if not mixed_waste_blocked():
                publish({"type": "mixed_waste_cleared"})
            # Camera clearance must not acknowledge an inductive transaction.

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
        station_status.update(
            visionFps=round(fps, 1), detections=display_detections,
            scanning=bool(accepted_detections) and not detector.locked and not station_status.get("manualRecoveryRequired"),
            platformClear=platform_clear,
            lastInferenceAt=time.time(),
        )


def handle_batch(device, batch: dict) -> None:
    detection_id = str(batch["detectionId"])
    if batch.get("source") == "ai_camera" and station_status.get("inductiveActive"):
        return  # A queued pre-metal camera classification cannot win the reservation.
    if station_status.get("manualRecoveryRequired"):
        publish({"type": "error", "message": station_status["lastError"]})
        return
    if mixed_waste_blocked():
        if batch.get("source") == "inductive_sensor":
            send(device, {"command": "recover", "detectionId": detection_id})
        publish({"type": "mixed_waste_rejected", "message": MIXED_WASTE_MESSAGE})
        return
    if not station_status.get("acceptingItems", True):
        if batch.get("source") == "inductive_sensor":
            ignored_detection_ids.append(detection_id)
            send(device, {"command": "recover", "detectionId": detection_id})
        publish({"type": "busy", "detectionId": detection_id, "message": "Choose Not done before placing the next item."})
        return
    if station_status.get("binFull"):
        if batch.get("source") == "inductive_sensor":
            ignored_detection_ids.append(detection_id)
            send(device, {"command": "recover", "detectionId": detection_id})
        publish({"type": "rejected", "detectionId": detection_id, "message": "Bin is full and needs collection."})
        return
    if not coordinator.begin(detection_id):
        publish({"type": "busy", "detectionId": detection_id, "message": "Another batch is active"})
        return
    station_status["activeSource"] = batch.get("source", "ai_camera")
    item_count = 1 if batch["wasteType"] == "Tin Can" else max(1, min(100, int(batch.get("itemCount") or 1)))
    batch.update(itemCount=item_count, confidence=round(float(batch.get("confidence") or 0), 3))
    set_workflow("PREPARING")
    send(device, {"command": "prepare", "detectionId": detection_id, "wasteType": batch["wasteType"], "itemCount": item_count, "source": batch.get("source", "ai_camera")})
    publish({"type": "item_detected", **batch, "pointsAvailable": round(POINTS_PER_ITEM[batch["wasteType"]] * item_count)})

    prepared = wait_for_event(detection_id, "prepared", SORT_TIMEOUT)
    if station_status.get("manualRecoveryRequired"):
        coordinator.clear()
        return
    prepare_error = "ESP32 could not prepare; no item was counted."
    if prepared and batch.get("source") == "inductive_sensor" and not SIMULATION_MODE:
        # Wait for an image captured after the metal reservation, not an old empty frame.
        capture_after = time.monotonic()
        deadline = capture_after + 8
        while (not mixed_waste_blocked() and not station_status.get("manualRecoveryRequired") and time.monotonic() < deadline
               and (station_status.get("lastInferenceCapturedAt", 0) <= capture_after
                    or not station_status.get("metalCheckReady"))):
            time.sleep(0.05)
        if station_status.get("lastInferenceCapturedAt", 0) <= capture_after or not station_status.get("metalCheckReady"):
            prepared = None
            prepare_error = "Camera check timed out. Remove the items and try again; no item was counted."
    if mixed_waste_blocked():
        send(device, {"command": "recover", "detectionId": detection_id})
        coordinator.clear()
        set_workflow("IDLE")
        publish({"type": "mixed_waste_rejected", "message": MIXED_WASTE_MESSAGE})
        return
    if not prepared or not prepared.get("success"):
        send(device, {"command": "recover", "detectionId": detection_id})
        coordinator.clear()
        set_workflow("IDLE", prepare_error)
        publish({"type": "error", "detectionId": detection_id, "message": prepare_error})
        return

    if mixed_waste_blocked():
        send(device, {"command": "recover", "detectionId": detection_id})
        coordinator.clear()
        set_workflow("IDLE")
        publish({"type": "mixed_waste_rejected", "message": MIXED_WASTE_MESSAGE})
        return
    if station_status.get("manualRecoveryRequired"):
        coordinator.clear()
        return
    with sensor_interlock_lock:
        # The camera's final mixed-waste check and motion commit must be
        # atomic. Once committed, changing AI labels cannot cancel the sort.
        if mixed_waste_blocked():
            send(device, {"command": "recover", "detectionId": detection_id})
            coordinator.clear()
            set_workflow("IDLE")
            publish({"type": "mixed_waste_rejected", "message": MIXED_WASTE_MESSAGE})
            return
        if batch.get("source") == "inductive_sensor":
            station_status["aiWasteVisible"] = False
        set_workflow("SORTING")
    send(device, {
        "command": "sort", "detectionId": detection_id, "wasteType": batch["wasteType"],
        "itemCount": item_count, "confidence": batch["confidence"],
        "source": batch.get("source", "ai_camera"),
    })
    result = wait_for_event(detection_id, "sorted", SORT_TIMEOUT)
    if station_status.get("manualRecoveryRequired"):
        coordinator.clear()
        return
    if mixed_waste_blocked():
        send(device, {"command": "recover", "detectionId": detection_id})
        coordinator.clear()
        set_workflow("IDLE")
        publish({"type": "mixed_waste_rejected", "message": MIXED_WASTE_MESSAGE})
        return
    if not result or not result.get("success"):
        message = "ESP32 sorting failed or timed out; no claim was created."
        publish({"type": "error", "detectionId": detection_id, "message": message})
        send(device, {"command": "recover", "detectionId": detection_id})
        coordinator.clear()
        set_workflow("ERROR_RECOVERY", message)
        set_workflow("IDLE")
        return
    station_status["acceptingItems"] = False
    publish({"type": "sorting_successful", **batch})
    backend_jobs.put({"kind": "claim", "batch": dict(batch)})
    set_workflow("WAITING_FOR_PLATFORM_EMPTY")
    if SIMULATION_MODE:
        threading.Timer(0.75, lambda: workflow_events.put({"event": "platform_empty", "detectionId": detection_id})).start()


def workflow_loop(device) -> None:
    while station_status["serial"]:
        try: message = workflow_events.get(timeout=0.5)
        except queue.Empty: continue
        process_workflow_event(device, message)


def process_workflow_event(device, message: dict) -> None:
    if handle_controller_recovery(message) or station_status.get("manualRecoveryRequired"):
        return
    event_name = message.get("event")
    detection_id = message.get("detectionId")
    if detection_id in ignored_detection_ids:
        if event_name in {"timeout", "error"}:
            publish({"type": "detection_ignored", "detectionId": detection_id,
                     "message": "Remove the extra item, then choose Not done before placing more waste."})
        return
    if event_name == "camera_batch":
        handle_batch(device, message)
    elif event_name == "platform_empty":
        active_id = coordinator.active_detection_id
        if not active_id or detection_id != active_id:
            return
        if station_status.get("activeSource") == "inductive_sensor" and message.get("source") == "camera_clear":
            return
        if active_id:
            send(device, {"command": "platform_empty", "detectionId": active_id})
            publish({"type": "platform_empty", "detectionId": active_id})
            coordinator.clear()
            station_status["activeSource"] = None
        set_workflow("IDLE")
    elif event_name == "inductive_detected":
        update_sensor_interlock(metal=True)
        station_status["lastInductiveDetectionAt"] = time.time()
        publish({"type": "inductive_confirmation", **message})
        handle_batch(device, batch_from_inductive(message))
    elif event_name in {"timeout", "error"}:
        if not coordinator.matches(detection_id):
            publish({"type": "station_warning", "detectionId": detection_id,
                     "message": message.get("message", "ESP32 warning")})
            return
        publish({"type": "error", "detectionId": message.get("detectionId"), "message": message.get("message", "ESP32 error")})
        coordinator.clear()
        set_workflow("IDLE")


def main(simulate: bool = False) -> None:
    global SIMULATION_MODE, active_model
    SIMULATION_MODE = simulate or SIMULATION_MODE
    station_status["simulation"] = SIMULATION_MODE
    load_point_rates()
    threading.Thread(target=run_local_api, daemon=True).start()
    threading.Thread(target=backend_worker, daemon=True).start()
    camera = None
    camera_thread = None
    device = None
    camera_stop.clear()
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
            active_model = model
            camera = cv2.VideoCapture(CAMERA_INDEX, cv2.CAP_DSHOW)
            if not camera.isOpened():
                camera.release()
                camera = cv2.VideoCapture(CAMERA_INDEX)
            if not camera.isOpened():
                raise RuntimeError("Camera could not be opened")
            camera_thread = threading.Thread(target=camera_preview_loop, args=(camera,), daemon=True)
            camera_thread.start()
            threading.Thread(target=vision_loop, args=(model,), daemon=True).start()
            device = serial.Serial(SERIAL_PORT, BAUD_RATE, timeout=0.25, write_timeout=1)
            time.sleep(2)
            station_status.update(online=True, serial=True, camera=True, lastError=None)
            threading.Thread(target=serial_reader, args=(device,), daemon=True).start()
        set_workflow("IDLE")
        print(f"Gateway ready ({'simulation' if SIMULATION_MODE else SERIAL_PORT}): http://127.0.0.1:{LOCAL_PORT}")
        workflow_loop(device)
    finally:
        station_status.update(online=False, serial=False)
        camera_stop.set()
        if camera_thread is not None: camera_thread.join(timeout=2)
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
