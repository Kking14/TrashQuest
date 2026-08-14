"""TrashQuest station gateway: ESP32 + YOLO + website/backend bridge.

The ESP32 owns sensors and motors. This process owns classification, reliable
HTTP reporting, and a small localhost event feed consumed by the React kiosk.
"""

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

import cv2
import serial
from dotenv import load_dotenv
from ultralytics import YOLO


ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env.station")
MODEL_PATH = Path(os.getenv("TQ_MODEL_PATH", ROOT / "paper detection" / "best.pt"))
if not MODEL_PATH.is_absolute():
    MODEL_PATH = ROOT / MODEL_PATH
SERIAL_PORT = os.getenv("TQ_SERIAL_PORT", "COM3")
BAUD_RATE = int(os.getenv("TQ_BAUD_RATE", "115200"))
CAMERA_INDEX = int(os.getenv("TQ_CAMERA_INDEX", "0"))
CONFIDENCE = float(os.getenv("TQ_CONFIDENCE", "0.63"))
BACKEND_URL = os.getenv("TQ_BACKEND_URL", "http://127.0.0.1:5001").rstrip("/")
DEVICE_KEY = os.getenv("TQ_DEVICE_KEY", "")
LOCAL_PORT = int(os.getenv("TQ_GATEWAY_PORT", "8765"))
DEFAULT_GRAMS = {"Paper": 80, "Plastic": 45, "Tin Can": 25}
PREVIEW_FPS = float(os.getenv("TQ_PREVIEW_FPS", "8"))
JPEG_QUALITY = int(os.getenv("TQ_JPEG_QUALITY", "80"))
PAPER_HOLD_SECONDS = float(os.getenv("TQ_PAPER_HOLD_SECONDS", "2.5"))
PAPER_REARM_SECONDS = float(os.getenv("TQ_PAPER_REARM_SECONDS", "1.0"))

events = deque(maxlen=100)
events_lock = threading.Lock()
serial_events: queue.Queue[dict] = queue.Queue()
sequence = 0
station_status = {"online": False, "serial": False, "camera": False, "lastError": None}
frame_lock = threading.Condition()
latest_jpeg: bytes | None = None
latest_detections: list[dict] = []
vision_sequence = 0
pending_confirmations: dict[str, queue.Queue[bool]] = {}
confirmation_lock = threading.Lock()


def publish(event: dict) -> None:
    global sequence
    with events_lock:
        sequence += 1
        events.append({"sequence": sequence, "timestamp": time.time(), **event})


def backend_claim(detection_id: str, waste_type: str, grams: int) -> dict:
    if not DEVICE_KEY:
        raise RuntimeError("TQ_DEVICE_KEY is not configured")
    payload = json.dumps({
        "wasteType": waste_type,
        "quantity": grams / 1000,
        "itemCount": 1,
        "detectionId": detection_id,
    }).encode()
    request = Request(
        f"{BACKEND_URL}/api/disposals/claims",
        data=payload,
        method="POST",
        headers={"Content-Type": "application/json", "X-Device-Key": DEVICE_KEY},
    )
    try:
        with urlopen(request, timeout=8) as response:
            return json.load(response)["data"]
    except HTTPError as error:
        detail = error.read().decode(errors="replace")
        raise RuntimeError(f"Backend returned HTTP {error.code}: {detail}") from error
    except URLError as error:
        raise RuntimeError(f"Backend is unavailable: {error.reason}") from error


def backend_fullness(is_full: bool, distance_cm: float | None = None) -> None:
    try:
        if not DEVICE_KEY:
            raise RuntimeError("TQ_DEVICE_KEY is not configured")
        payload = json.dumps({"isFull": is_full}).encode()
        request = Request(
            f"{BACKEND_URL}/api/bins/sensor/full-status",
            data=payload,
            method="PUT",
            headers={"Content-Type": "application/json", "X-Device-Key": DEVICE_KEY},
        )
        with urlopen(request, timeout=8) as response:
            result = json.load(response)["data"]
        station_status.update(
            binFull=is_full,
            fullnessDistanceCm=distance_cm,
            lastFullnessReportAt=time.time(),
        )
        publish({
            "type": "bin_fullness", "isFull": is_full,
            "distanceCm": distance_cm, "bin": result,
        })
        print(f"Backend <- bin fullness: {'FULL' if is_full else 'available'} ({distance_cm} cm)")
    except HTTPError as error:
        detail = error.read().decode(errors="replace")
        station_status["lastError"] = f"Fullness report HTTP {error.code}: {detail}"
    except (URLError, OSError) as error:
        station_status["lastError"] = f"Fullness report failed: {error}"
    except RuntimeError as error:
        station_status["lastError"] = str(error)


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

    def do_GET(self) -> None:
        path, _, query = self.path.partition("?")
        if path == "/health":
            self._json(200, station_status)
            return
        if path == "/events":
            after = 0
            for part in query.split("&"):
                if part.startswith("after="):
                    try:
                        after = int(part[6:])
                    except ValueError:
                        pass
            with events_lock:
                result = [item for item in events if item["sequence"] > after]
            self._json(200, {"events": result})
            return
        if path == "/camera.mjpg":
            self.send_response(200)
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
            self.end_headers()
            last_sequence = -1
            try:
                while True:
                    with frame_lock:
                        frame_lock.wait_for(
                            lambda: vision_sequence != last_sequence or latest_jpeg is None,
                            timeout=2,
                        )
                        image = latest_jpeg
                        last_sequence = vision_sequence
                    if not image:
                        time.sleep(0.1)
                        continue
                    self.wfile.write(b"--frame\r\n")
                    self.wfile.write(b"Content-Type: image/jpeg\r\n")
                    self.wfile.write(f"Content-Length: {len(image)}\r\n\r\n".encode())
                    self.wfile.write(image)
                    self.wfile.write(b"\r\n")
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        self._json(404, {"message": "Not found"})

    def do_OPTIONS(self) -> None:
        self._json(204, {})

    def do_POST(self) -> None:
        if self.path != "/confirm":
            self._json(404, {"message": "Not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length) or b"{}")
            detection_id = str(body.get("detectionId") or "")
            accepted = body.get("accepted")
            if not detection_id or not isinstance(accepted, bool):
                self._json(400, {"message": "detectionId and boolean accepted are required"})
                return
            with confirmation_lock:
                confirmation = pending_confirmations.get(detection_id)
            if confirmation is None:
                self._json(404, {"message": "Detection is no longer waiting for confirmation"})
                return
            confirmation.put_nowait(accepted)
            self._json(202, {"success": True, "accepted": accepted})
        except (ValueError, json.JSONDecodeError):
            self._json(400, {"message": "Invalid JSON request"})

    def log_message(self, *_args) -> None:
        return


class GatewayServer(ThreadingHTTPServer):
    # Camera viewers keep a request open indefinitely. Daemon handler threads
    # let Ctrl+C terminate the gateway even while a browser is viewing MJPEG.
    daemon_threads = True
    allow_reuse_address = True


def run_local_api() -> None:
    GatewayServer(("127.0.0.1", LOCAL_PORT), GatewayHandler).serve_forever()


def serial_reader(device: serial.Serial) -> None:
    while True:
        try:
            line = device.readline().decode(errors="replace").strip()
            if not line:
                continue
            message = json.loads(line)
            if message.get("event") == "bin_fullness":
                threading.Thread(
                    target=backend_fullness,
                    args=(bool(message.get("isFull")), message.get("distanceCm")),
                    daemon=True,
                ).start()
                continue
            serial_events.put(message)
            print("ESP32 ->", message)
        except json.JSONDecodeError:
            print("Ignored non-JSON serial line:", line)
        except Exception as error:
            station_status.update(serial=False, online=False, lastError=str(error))
            return


def vision_loop(model: YOLO, camera) -> None:
    global latest_jpeg, latest_detections, vision_sequence
    previous = time.perf_counter()
    paper_started_at = None
    paper_missing_at = None
    paper_armed = True
    while True:
        ok, frame = camera.read()
        if not ok:
            station_status.update(camera=False, lastError="Camera frame could not be read")
            time.sleep(0.2)
            continue

        result = model.predict(frame, conf=CONFIDENCE, verbose=False)[0]
        detections = []
        for box in result.boxes:
            class_id = int(box.cls[0])
            name = str(model.names[class_id]).upper()
            confidence = float(box.conf[0])
            x1, y1, x2, y2 = map(int, box.xyxy[0])
            detections.append({"className": name, "confidence": confidence})
            color = (66, 214, 137) if name in {"PAPER", "CARDBOARD"} else (63, 169, 245)
            cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
            label = f"{name} {confidence:.0%}"
            cv2.rectangle(frame, (x1, max(0, y1 - 26)), (x1 + 10 + 9 * len(label), y1), color, -1)
            cv2.putText(frame, label, (x1 + 5, max(17, y1 - 7)), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (8, 20, 16), 2)

        now = time.perf_counter()
        paper_visible = any(
            item["className"] in {"PAPER", "CARDBOARD"} and item["confidence"] >= CONFIDENCE
            for item in detections
        )
        if paper_visible:
            paper_missing_at = None
            if paper_started_at is None:
                paper_started_at = now
            held_for = now - paper_started_at
            station_status["paperHoldProgress"] = round(min(1.0, held_for / PAPER_HOLD_SECONDS), 2)
            if paper_armed and held_for >= PAPER_HOLD_SECONDS:
                best = max(
                    item["confidence"] for item in detections
                    if item["className"] in {"PAPER", "CARDBOARD"}
                )
                serial_events.put({
                    "event": "ai_paper_ready",
                    "detectionId": f"camera-{uuid.uuid4()}",
                    "confidence": best,
                    "grams": DEFAULT_GRAMS["Paper"],
                })
                paper_armed = False
                station_status["paperHoldProgress"] = 1.0
        else:
            paper_started_at = None
            station_status["paperHoldProgress"] = 0.0
            if paper_missing_at is None:
                paper_missing_at = now
            if not paper_armed and now - paper_missing_at >= PAPER_REARM_SECONDS:
                paper_armed = True

        fps = 1 / max(now - previous, 0.001)
        previous = now
        cv2.putText(frame, f"TrashQuest AI  {fps:.1f} FPS", (12, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (66, 214, 137), 2)
        encoded, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
        if encoded:
            with frame_lock:
                latest_jpeg = jpeg.tobytes()
                latest_detections = detections
                vision_sequence += 1
                frame_lock.notify_all()
            station_status.update(camera=True, visionFps=round(fps, 1), detections=detections, lastFrameAt=time.time())
        elapsed = time.perf_counter() - now
        time.sleep(max(0, (1 / max(PREVIEW_FPS, 1)) - elapsed))


def classify(sensor_event: dict) -> tuple[str | None, float]:
    if sensor_event.get("metal") is True:
        return "Tin Can", 1.0

    best_paper = 0.0
    for _ in range(5):
        with frame_lock:
            detections = list(latest_detections)
        for detection in detections:
            name = detection["className"]
            confidence = detection["confidence"]
            if name in {"PAPER", "CARDBOARD"}:
                best_paper = max(best_paper, confidence)
        time.sleep(0.15)
    if best_paper >= CONFIDENCE:
        return "Paper", best_paper
    if sensor_event.get("objectPresent") is True:
        return "Plastic", 1.0
    return None, 0.0


def send(device: serial.Serial, message: dict) -> None:
    device.write((json.dumps(message, separators=(",", ":")) + "\n").encode())
    device.flush()
    print("ESP32 <-", message)


def main() -> None:
    threading.Thread(target=run_local_api, daemon=True).start()
    if not MODEL_PATH.exists():
        raise FileNotFoundError(f"YOLO model not found: {MODEL_PATH}")

    model = YOLO(str(MODEL_PATH))
    camera = cv2.VideoCapture(CAMERA_INDEX, cv2.CAP_DSHOW)
    if not camera.isOpened():
        camera.release()
        camera = cv2.VideoCapture(CAMERA_INDEX)
    station_status["camera"] = camera.isOpened()
    if not camera.isOpened():
        raise RuntimeError("Camera could not be opened")
    threading.Thread(target=vision_loop, args=(model, camera), daemon=True).start()

    with serial.Serial(SERIAL_PORT, BAUD_RATE, timeout=1) as device:
        time.sleep(2)
        station_status.update(online=True, serial=True, lastError=None)
        threading.Thread(target=serial_reader, args=(device,), daemon=True).start()
        print(f"Gateway ready: ESP32={SERIAL_PORT}@{BAUD_RATE}, kiosk=http://127.0.0.1:{LOCAL_PORT}")

        while station_status["serial"]:
            message = serial_events.get()
            event_name = message.get("event")
            if event_name not in {"object_ready", "ai_paper_ready"}:
                continue
            detection_id = message.get("detectionId") or str(uuid.uuid4())
            if event_name == "ai_paper_ready":
                waste_type, confidence = "Paper", float(message.get("confidence") or CONFIDENCE)
            else:
                waste_type, confidence = classify(message)
            if not waste_type:
                send(device, {"command": "reject", "detectionId": detection_id})
                publish({"type": "rejected", "detectionId": detection_id})
                continue

            grams = int(message.get("grams") or DEFAULT_GRAMS[waste_type])
            confirmation: queue.Queue[bool] = queue.Queue(maxsize=1)
            with confirmation_lock:
                pending_confirmations[detection_id] = confirmation
            publish({
                "type": "item_detected", "detectionId": detection_id,
                "wasteType": waste_type, "grams": grams, "confidence": confidence,
            })
            try:
                accepted = confirmation.get(timeout=120)
            except queue.Empty:
                accepted = False
                publish({
                    "type": "error", "detectionId": detection_id,
                    "message": "Identification confirmation timed out",
                })
            finally:
                with confirmation_lock:
                    pending_confirmations.pop(detection_id, None)

            if not accepted:
                if event_name == "object_ready":
                    send(device, {"command": "reject", "detectionId": detection_id})
                publish({"type": "detection_cancelled", "detectionId": detection_id})
                continue

            send(device, {
                "command": "sort", "detectionId": detection_id,
                "wasteType": waste_type, "confidence": round(confidence, 3),
                "source": "ai_camera" if event_name == "ai_paper_ready" else "sensors",
            })
            while True:
                try:
                    result = serial_events.get(timeout=20)
                except queue.Empty:
                    publish({"type": "error", "detectionId": detection_id, "message": "ESP32 sort timed out"})
                    break
                if result.get("event") == "sorted" and result.get("detectionId") == detection_id:
                    break
            if result.get("event") != "sorted" or not result.get("success"):
                publish({"type": "error", "detectionId": detection_id, "message": "Sorting failed"})
                continue

            try:
                claim = backend_claim(detection_id, waste_type, grams)
                publish({
                    "type": "item_sorted", "detectionId": detection_id,
                    "wasteType": waste_type, "grams": grams,
                    "confidence": confidence, **claim,
                })
            except Exception as error:
                station_status["lastError"] = str(error)
                publish({"type": "error", "detectionId": detection_id, "message": str(error)})


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except Exception as error:
        station_status.update(online=False, lastError=str(error))
        raise
