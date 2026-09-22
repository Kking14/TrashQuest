"""
TrashQuest - AI Detection + Arduino Serial Sender
Sends top detected object data to Arduino in this format:
CLASS:METAL,CONF:0.87,ID:12
"""

import cv2
from ultralytics import YOLO
import time
import os
import threading
import tkinter as tk
from tkinter.scrolledtext import ScrolledText
from datetime import datetime
from pathlib import Path
import serial

MODEL_PATH = str(Path(__file__).resolve().with_name("best.pt"))
CONFIDENCE_THRESHOLD = 0.63
WEBCAM_INDEX = 0
DISPLAY_FPS = True

SERIAL_PORT = "COM3"   # CHANGE THIS
BAUD_RATE = 9600
SEND_COOLDOWN = 2.0

CLASS_COLORS = {
    "PAPER": (0, 0, 255),
    "CARDBOARD": (0, 128, 255),
    "PLASTIC": (255, 0, 0),
    "METAL": (128, 128, 128),
    "GLASS": (255, 255, 0),
    "BIODEGRADABLE": (0, 255, 0),
}

latest_report = "Waiting for detections..."
latest_arduino_status = "Arduino: Not connected"
running = True
arduino = None
last_sent_time = 0


def connect_arduino():
    global arduino, latest_arduino_status
    try:
        arduino = serial.Serial(SERIAL_PORT, BAUD_RATE, timeout=1)
        time.sleep(2)
        latest_arduino_status = f"Arduino: Connected on {SERIAL_PORT}"
        print(f"[INFO] Connected to Arduino on {SERIAL_PORT}")
    except Exception as e:
        arduino = None
        latest_arduino_status = f"Arduino: Connection failed - {e}"
        print(f"[ERROR] Arduino connection failed: {e}")


def send_ai_data(class_name, conf, obj_id):
    global latest_arduino_status
    if arduino and arduino.is_open:
        message = f"CLASS:{class_name},CONF:{conf:.2f},ID:{obj_id}\n"
        arduino.write(message.encode())
        latest_arduino_status = f"Sent: {message.strip()}"
        print(f"[INFO] Sent to Arduino -> {message.strip()}")


def read_arduino_feedback():
    global latest_arduino_status
    try:
        if arduino and arduino.is_open and arduino.in_waiting:
            msg = arduino.readline().decode(errors="ignore").strip()
            if msg:
                latest_arduino_status = f"Arduino says: {msg}"
    except Exception as e:
        latest_arduino_status = f"Arduino read error: {e}"


def build_report(detected_objects, fps):
    now = datetime.now().strftime("%Y-%m-%d %I:%M:%S %p")
    lines = [
        "TrashQuest AI Live Detection",
        "=" * 42,
        f"Timestamp: {now}",
        f"FPS: {fps:.2f}",
        latest_arduino_status,
        "",
        "Tracked Object Details:"
    ]

    if detected_objects:
        for obj in detected_objects:
            lines.append(
                f"ID: {obj['id']} | Class: {obj['class_name']} | "
                f"Conf: {obj['conf']:.2f} | "
                f"Box: ({obj['x1']}, {obj['y1']}) to ({obj['x2']}, {obj['y2']})"
            )
    else:
        lines.append("No tracked objects")

    return "\n".join(lines)


def open_camera(index):
    cap = cv2.VideoCapture(index, cv2.CAP_DSHOW)
    if not cap.isOpened():
        cap.release()
        cap = cv2.VideoCapture(index)
    return cap


def gui_thread():
    global latest_report, running

    root = tk.Tk()
    root.title("TrashQuest Live Detection Data")
    root.geometry("560x680")
    root.configure(bg="#1e1e1e")

    title = tk.Label(root, text="TrashQuest AI Live Data",
                     font=("Arial", 14, "bold"), fg="white", bg="#1e1e1e")
    title.pack(pady=10)

    text_area = ScrolledText(root, wrap=tk.WORD, font=("Consolas", 10),
                             bg="#111111", fg="#00ff88", insertbackground="white")
    text_area.pack(fill=tk.BOTH, expand=True, padx=10, pady=10)

    def refresh_text():
        if not running:
            root.destroy()
            return
        text_area.config(state=tk.NORMAL)
        text_area.delete("1.0", tk.END)
        text_area.insert(tk.END, latest_report)
        text_area.config(state=tk.DISABLED)
        root.after(500, refresh_text)

    def on_close():
        global running
        running = False
        root.destroy()

    root.protocol("WM_DELETE_WINDOW", on_close)
    refresh_text()
    root.mainloop()


def run_detection():
    global latest_report, running, last_sent_time

    abs_path = os.path.abspath(MODEL_PATH)
    if not os.path.exists(abs_path):
        print(f"[ERROR] Model not found at: {abs_path}")
        return

    print(f"[INFO] Loading model from: {abs_path}")
    model = YOLO(abs_path)
    print(f"[INFO] Model loaded. Classes: {model.names}")

    connect_arduino()

    cap = open_camera(WEBCAM_INDEX)
    if not cap.isOpened():
        print("[ERROR] Cannot open webcam.")
        return

    prev_time = time.time()

    while running:
        ret, frame = cap.read()
        if not ret:
            print("[ERROR] Failed to grab frame.")
            break

        results = model.track(frame, conf=CONFIDENCE_THRESHOLD, persist=True, verbose=False)
        boxes = results[0].boxes
        annotated = frame.copy()

        curr_time = time.time()
        fps = 1 / (curr_time - prev_time + 1e-6)
        prev_time = curr_time

        detected_objects = []

        if boxes is not None and len(boxes) > 0:
            xyxy = boxes.xyxy.cpu().numpy()
            cls_ids = boxes.cls.cpu().numpy()
            confs = boxes.conf.cpu().numpy()
            track_ids = boxes.id.int().cpu().tolist() if boxes.id is not None else None

            for i in range(len(boxes)):
                class_id = int(cls_ids[i])
                class_name = str(model.names[class_id]).upper()
                conf = float(confs[i])
                x1, y1, x2, y2 = map(int, xyxy[i])
                obj_id = track_ids[i] if track_ids is not None else i + 1

                detected_objects.append({
                    "id": obj_id,
                    "class_name": class_name,
                    "conf": conf,
                    "x1": x1, "y1": y1, "x2": x2, "y2": y2
                })

                color = CLASS_COLORS.get(class_name, (255, 255, 255))
                cv2.rectangle(annotated, (x1, y1), (x2, y2), color, 2)
                cv2.putText(annotated, f"{class_name} {conf:.2f}",
                            (x1, max(y1 - 10, 20)),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)

        if detected_objects:
            top_obj = max(detected_objects, key=lambda x: x["conf"])
            current_time = time.time()
            if current_time - last_sent_time > SEND_COOLDOWN:
                send_ai_data(top_obj["class_name"], top_obj["conf"], top_obj["id"])
                last_sent_time = current_time

        read_arduino_feedback()

        if DISPLAY_FPS:
            cv2.putText(annotated, f"FPS: {fps:.1f}", (10, 30),
                        cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 255, 0), 2)

        latest_report = build_report(detected_objects, fps)

        cv2.imshow("TrashQuest Waste Detector | Q=Quit", annotated)

        key = cv2.waitKey(1) & 0xFF
        if key in (ord('q'), ord('Q')):
            running = False
            break

    cap.release()
    cv2.destroyAllWindows()

    try:
        if arduino and arduino.is_open:
            arduino.close()
    except:
        pass


if __name__ == "__main__":
    t = threading.Thread(target=gui_thread, daemon=True)
    t.start()
    run_detection()
