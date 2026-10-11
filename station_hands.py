"""Independent latest-frame hand detector; no dependency on waste classification."""
import queue
import threading
import time


class HandMonitor:
    def __init__(self, roi, clear_seconds=0.8, max_age=1.0):
        self.roi = roi
        self.clear_seconds = clear_seconds
        self.max_age = max_age
        self.captured_at = None
        self.clear_since = None
        self.present = False
        self.positive_frames = 0
        self.boxes = []
        self.error = None
        self.lock = threading.RLock()
        self.frames = queue.Queue(maxsize=1)

    def offer(self, frame, captured_at):
        try: self.frames.get_nowait()
        except queue.Empty: pass
        self.frames.put_nowait((frame, captured_at))

    def update(self, boxes, captured_at):
        with self.lock:
            if self.captured_at is not None and captured_at <= self.captured_at:
                return
            x1, y1, x2, y2 = self.roi
            self.boxes = [b for b in boxes if b[0] < x2 and b[2] > x1 and b[1] < y2 and b[3] > y1]
            gap = self.captured_at is None or captured_at - self.captured_at > self.max_age
            if self.boxes:
                self.positive_frames = 1 if gap else self.positive_frames + 1
                self.clear_since = None
            else:
                self.positive_frames = 0
                if self.clear_since is None or gap:
                    self.clear_since = captured_at
            # One noisy frame cannot interrupt an active disposal.
            self.present = self.positive_frames >= 2
            self.captured_at = captured_at
            self.error = None

    def fresh(self, now=None):
        now = time.monotonic() if now is None else now
        return self.error is None and self.captured_at is not None and 0 <= now - self.captured_at <= self.max_age

    def clear(self, now=None):
        with self.lock:
            return self.fresh(now) and not self.present and self.clear_since is not None and self.captured_at - self.clear_since >= self.clear_seconds

    def run(self, model, stop, confidence=0.65):
        while not stop.is_set():
            try: frame, captured_at = self.frames.get(timeout=0.2)
            except queue.Empty: continue
            try:
                result = model.predict(frame, conf=confidence, imgsz=640, device='cpu', verbose=False)[0]
                boxes = [] if result.boxes is None else result.boxes.xyxyn.tolist()
                self.update(boxes, captured_at)
            except Exception as error:
                with self.lock:
                    self.error = str(error)
                    self.clear_since = None
                stop.wait(0.2)
