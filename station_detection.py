"""Pure detection/state helpers shared by the station gateway and tests."""

from collections import Counter, deque
from dataclasses import dataclass
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
    """Stabilize waste type and box count, then lock until the platform is empty."""

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
        self.mixed_blocked = False

    def _inside_roi(self, detection):
        x1, y1, x2, y2 = detection.box
        rx1, ry1, rx2, ry2 = self.roi
        return rx1 <= (x1 + x2) / 2 <= rx2 and ry1 <= (y1 + y2) / 2 <= ry2

    def update(self, detections: Iterable[Detection], now: float):
        visible = [item for item in detections if item.confidence >= max(0.05, self.minimum_confidence * 0.75) and self._inside_roi(item)]
        accepted = [item for item in visible if item.confidence >= self.minimum_confidence]
        waste_types = tuple(sorted({item.waste_type for item in visible}))
        if len(waste_types) > 1 and not self.mixed_blocked:
            self.mixed_blocked = True
            self.locked = True
            self.empty_since = None
            return StableBatch(status="mixed", waste_types=waste_types)
        if not visible:
            self.history.clear()
            self.signature = None
            self.signature_since = None
            if self.empty_since is None:
                self.empty_since = now
            if self.locked and now - self.empty_since >= self.empty_seconds:
                self.locked = False
                self.mixed_blocked = False
                return StableBatch(status="rearmed")
            return None

        self.empty_since = None
        if self.mixed_blocked:
            return None
        if not accepted:
            self.signature = None
            self.signature_since = None
            self.history.clear()
            return None
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
        confidences = [item.confidence for item in accepted if item.waste_type == waste_type]
        return StableBatch("accepted", waste_type, counts[waste_type], sum(confidences) / len(confidences))


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


class MetalObjectMatcher:
    """Associate at most one visible object with the metal sensor, then track it.

    More than one candidate is ambiguous: no box is suppressed. A lost track
    can only be reacquired at the sensor with a live metal signal.
    """

    def __init__(self, sensor_roi, stable_seconds=0.3, lost_seconds=0.75):
        self.sensor_roi = sensor_roi
        self.stable_seconds = stable_seconds
        self.lost_seconds = lost_seconds
        self.reset()

    def reset(self):
        self.box = None
        self.since = None
        self.last_seen = None

    @staticmethod
    def overlap(a, b):
        area = max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(0, min(a[3], b[3]) - max(a[1], b[1]))
        union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - area
        return area / union if union > 0 else 0

    def update(self, detections, *, metal_active, transaction_active, now):
        detections = list(detections)
        if not metal_active and not transaction_active:
            self.reset()
            return detections, None, False
        if self.last_seen is not None and now - self.last_seen > self.lost_seconds:
            self.reset()
        if self.box is not None:
            candidates = [i for i, item in enumerate(detections) if self.overlap(item.box, self.box) >= 0.2]
        else:
            sx = (self.sensor_roi[0] + self.sensor_roi[2]) / 2
            sy = (self.sensor_roi[1] + self.sensor_roi[3]) / 2
            candidates = [i for i, item in enumerate(detections)
                          if metal_active and item.box[0] <= sx <= item.box[2] and item.box[1] <= sy <= item.box[3]]
        if len(candidates) != 1:
            # No visual candidate is required for sensor-only metal detection.
            # Visible unmatched/ambiguous objects still trigger the interlock.
            if candidates:
                self.reset()
            return detections, None, False
        index = candidates[0]
        matched = detections[index]
        if self.since is None:
            self.since = now
        self.box = matched.box
        self.last_seen = now
        return [item for i, item in enumerate(detections) if i != index], matched, now - self.since < self.stable_seconds
