import unittest
from station_detection import BatchCoordinator, Detection, PlatformClearTracker, StableBatchDetector


def box(waste_type="Plastic", confidence=0.9, bounds=(0.3, 0.3, 0.4, 0.5)):
    return Detection(waste_type, confidence, bounds)


class StableBatchDetectorTests(unittest.TestCase):
    def make_detector(self):
        return StableBatchDetector(roi=(0.2, 0.2, 0.8, 0.8), minimum_confidence=0.6, stability_seconds=1.0, empty_seconds=0.5)

    def test_stable_count_uses_individual_boxes(self):
        detector = self.make_detector()
        objects = [box(bounds=(0.25 + i * 0.1, 0.3, 0.3 + i * 0.1, 0.5)) for i in range(3)]
        self.assertIsNone(detector.update(objects, 0.0))
        result = detector.update(objects, 1.1)
        self.assertEqual((result.status, result.waste_type, result.item_count), ("accepted", "Plastic", 3))

    def test_filters_confidence_and_roi(self):
        detector = self.make_detector()
        visible = [box(), box(confidence=0.2), box(bounds=(0.85, 0.85, 0.95, 0.95))]
        detector.update(visible, 0.0)
        self.assertEqual(detector.update(visible, 1.1).item_count, 1)

    def test_rejects_stable_mixed_waste(self):
        detector = self.make_detector()
        mixed = [box("Plastic"), box("Paper", bounds=(0.5, 0.3, 0.6, 0.5))]
        detector.update(mixed, 0.0)
        result = detector.update(mixed, 1.1)
        self.assertEqual((result.status, result.waste_types), ("mixed", ("Paper", "Plastic")))

    def test_duplicate_is_locked_until_empty(self):
        detector = self.make_detector()
        detector.update([box()], 0.0)
        self.assertEqual(detector.update([box()], 1.1).status, "accepted")
        self.assertIsNone(detector.update([box()], 5.0))
        detector.update([], 5.1)
        self.assertEqual(detector.update([], 5.7).status, "rearmed")

    def test_simultaneous_batches_are_serialized(self):
        coordinator = BatchCoordinator()
        self.assertTrue(coordinator.begin("first"))
        self.assertFalse(coordinator.begin("second"))
        self.assertFalse(coordinator.matches("old"))


class PlatformClearTrackerTests(unittest.TestCase):
    def test_clear_platform_signals_after_debounce(self):
        tracker = PlatformClearTracker(1.2)
        self.assertEqual(tracker.update(has_object=False, now=0.0, active_detection_id="batch-1", waiting_for_empty=True), (False, False))
        self.assertEqual(tracker.update(has_object=False, now=1.3, active_detection_id="batch-1", waiting_for_empty=True), (True, True))
        self.assertEqual(tracker.update(has_object=False, now=2.0, active_detection_id="batch-1", waiting_for_empty=True), (True, False))

    def test_visible_object_prevents_rearm(self):
        tracker = PlatformClearTracker(1.2)
        tracker.update(has_object=False, now=0.0, active_detection_id="batch-1", waiting_for_empty=True)
        self.assertEqual(tracker.update(has_object=True, now=2.0, active_detection_id="batch-1", waiting_for_empty=True), (False, False))


if __name__ == "__main__":
    unittest.main()
