"""Pure detection/state helpers shared by the station gateway and tests."""

from collections import Counter, deque
from dataclasses import dataclass
from statistics import median
from typing import Iterable


@dataclass(frozen=True)
class Detection:
    waste_type: str
    confidence: float
    box: tuple[float, float, float, float]


@dataclass(frozen=True)
class StableBatch:
    status: str
    waste_type: str | None = None
    item_count: int = 0
    confidence: float = 0.0
    waste_types: tuple[str, ...] = ()


class StableBatchDetector:
    """Accept one stable single-material set of boxes, then lock until empty."""

    def __init__(self, *, roi, minimum_confidence, stability_seconds, empty_seconds, history_size=24):
        self.roi = roi
        self.minimum_confidence = minimum_confidence
        self.stability_seconds = stability_seconds
        self.empty_seconds = empty_seconds
        self.history = deque(maxlen=history_size)
        self.signature = None
        self.signature_since = None
        self.empty_since = None
        self.locked = False

    def _inside_roi(self, detection):
        x1, y1, x2, y2 = detection.box
        rx1, ry1, rx2, ry2 = self.roi
        return rx1 <= (x1 + x2) / 2 <= rx2 and ry1 <= (y1 + y2) / 2 <= ry2

    def update(self, detections: Iterable[Detection], now: float):
        accepted = [item for item in detections if item.confidence >= self.minimum_confidence and self._inside_roi(item)]
        if not accepted:
            self.history.clear()
            self.signature = None
            self.signature_since = None
            if self.empty_since is None:
                self.empty_since = now
            if self.locked and now - self.empty_since >= self.empty_seconds:
                self.locked = False
                return StableBatch(status="rearmed")
            return None

        self.empty_since = None
        counts = Counter(item.waste_type for item in accepted)
        signature = tuple(sorted(counts.items()))
        if signature != self.signature:
            self.signature = signature
            self.signature_since = now
            self.history.clear()
        self.history.append(counts)
        if self.locked or self.signature_since is None or now - self.signature_since < self.stability_seconds:
            return None
        waste_types = tuple(sorted(counts))
        self.locked = True
        if len(waste_types) != 1:
            return StableBatch(status="mixed", waste_types=waste_types)
        waste_type = waste_types[0]
        stable_counts = [entry[waste_type] for entry in self.history if set(entry) == {waste_type}]
        confidences = [item.confidence for item in accepted if item.waste_type == waste_type]
        return StableBatch("accepted", waste_type, max(1, int(median(stable_counts))), sum(confidences) / len(confidences))


class BatchCoordinator:
    def __init__(self):
        self.active_detection_id = None

    def begin(self, detection_id):
        if self.active_detection_id is not None:
            return False
        self.active_detection_id = detection_id
        return True

    def matches(self, detection_id):
        return bool(detection_id and detection_id == self.active_detection_id)

    def clear(self):
        self.active_detection_id = None


class PlatformClearTracker:
    """Debounce camera emptiness and emit at most once for each active batch."""

    def __init__(self, empty_seconds):
        self.empty_seconds = empty_seconds
        self.empty_since = None
        self.signaled_detection_id = None

    def update(self, *, has_object, now, active_detection_id, waiting_for_empty):
        if has_object:
            self.empty_since = None
            return False, False
        if self.empty_since is None:
            self.empty_since = now
        is_clear = now - self.empty_since >= self.empty_seconds
        should_signal = bool(
            is_clear
            and waiting_for_empty
            and active_detection_id
            and active_detection_id != self.signaled_detection_id
        )
        if should_signal:
            self.signaled_detection_id = active_detection_id
        return is_clear, should_signal
