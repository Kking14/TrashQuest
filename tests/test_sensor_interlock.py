import unittest
from unittest.mock import Mock, patch

import station_gateway as gateway
from station_detection import Detection, StableBatchDetector


class SensorInterlockTests(unittest.TestCase):
    def setUp(self):
        self.state = gateway.station_status.copy()
        self.clear_since = gateway.sensor_clear_since
        gateway.sensor_clear_since = None
        gateway.station_status.update(inductiveActive=False, aiWasteVisible=False,
                                      sensorMixedBlocked=False, mixedWasteBlocked=False,
                                      activeSource=None, workflowState="IDLE")

    def tearDown(self):
        gateway.station_status.clear()
        gateway.station_status.update(self.state)
        gateway.sensor_clear_since = self.clear_since

    def test_both_arrival_orders_block(self):
        for metal_first in (True, False):
            gateway.station_status.update(inductiveActive=False, aiWasteVisible=False, sensorMixedBlocked=False)
            if metal_first:
                gateway.update_sensor_interlock(metal=True)
                gateway.update_sensor_interlock(ai_visible=True)
            else:
                gateway.update_sensor_interlock(ai_visible=True)
                gateway.update_sensor_interlock(metal=True)
                # Re-evaluate after the metal edge: the earlier AI box may
                # belong to the can itself. True here means a separate object.
                gateway.update_sensor_interlock(ai_visible=True)
            self.assertTrue(gateway.mixed_waste_blocked())

    def test_one_sensor_alone_does_not_block(self):
        self.assertFalse(gateway.update_sensor_interlock(metal=True))
        gateway.update_sensor_interlock(metal=False)
        self.assertFalse(gateway.update_sensor_interlock(ai_visible=True))

    def test_requires_both_sensors_clear_for_debounce(self):
        gateway.update_sensor_interlock(metal=True, ai_visible=True)
        self.assertTrue(gateway.update_sensor_interlock(ai_visible=False))
        with patch.object(gateway.time, "monotonic", return_value=10):
            self.assertTrue(gateway.update_sensor_interlock(metal=False))
        with patch.object(gateway.time, "monotonic", return_value=10 + gateway.EMPTY_REARM_SECONDS + 0.1):
            self.assertFalse(gateway.update_sensor_interlock(ai_visible=False))

    def test_metal_during_ai_sort_blocks_even_if_object_has_moved(self):
        gateway.station_status.update(activeSource="ai_camera", workflowState="SORTING")
        self.assertTrue(gateway.update_sensor_interlock(metal=True))

    def test_metal_and_camera_prevent_prepare(self):
        gateway.update_sensor_interlock(ai_visible=True, metal=True)
        device = Mock()
        gateway.handle_batch(device, {"detectionId": "mixed", "wasteType": "Plastic", "source": "ai_camera"})
        device.write.assert_not_called()

    def test_wait_aborts_instead_of_waiting_for_sort_completion(self):
        gateway.update_sensor_interlock(ai_visible=True, metal=True)
        self.assertIsNone(gateway.wait_for_event("mixed", "sorted", 30))

    def test_camera_during_committed_metal_sort_does_not_cancel_motion(self):
        gateway.station_status.update(activeSource="inductive_sensor", workflowState="SORTING")
        self.assertFalse(gateway.update_sensor_interlock(ai_visible=True))
        self.assertFalse(gateway.station_status["aiWasteVisible"])

    def test_camera_label_flip_during_committed_paper_sort_is_ignored(self):
        detector = StableBatchDetector(roi=(0, 0, 1, 1), minimum_confidence=0.6,
                                       stability_seconds=0.1, empty_seconds=1.2)
        paper = Detection("Paper", 0.9, (0.2, 0.2, 0.4, 0.4))
        plastic = Detection("Plastic", 0.9, (0.2, 0.2, 0.4, 0.4))
        gateway.update_camera_stability(detector, [paper], 1.0)
        stable = gateway.update_camera_stability(detector, [paper], 1.2)
        self.assertEqual(stable.waste_type, "Paper")
        gateway.station_status.update(activeSource="ai_camera", workflowState="SORTING")
        self.assertIsNone(gateway.update_camera_stability(detector, [paper, plastic], 1.3))
        self.assertFalse(gateway.mixed_waste_blocked())
        self.assertEqual(detector.signature, (("Paper", 1),))

    def test_mixed_paper_and_plastic_before_sort_still_blocks(self):
        detector = StableBatchDetector(roi=(0, 0, 1, 1), minimum_confidence=0.6,
                                       stability_seconds=0.1, empty_seconds=1.2)
        paper = Detection("Paper", 0.9, (0.2, 0.2, 0.4, 0.4))
        plastic = Detection("Plastic", 0.9, (0.6, 0.2, 0.8, 0.4))
        gateway.station_status.update(activeSource="ai_camera", workflowState="PREPARING")
        stable = gateway.update_camera_stability(detector, [paper, plastic], 1.0)
        self.assertEqual(stable.status, "mixed")
        self.assertTrue(gateway.mixed_waste_blocked())
