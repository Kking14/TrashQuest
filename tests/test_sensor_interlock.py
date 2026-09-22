import unittest
from unittest.mock import Mock, patch

import station_gateway as gateway


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

    def test_camera_during_metal_sort_blocks_after_sensor_release(self):
        gateway.station_status.update(activeSource="inductive_sensor", workflowState="SORTING")
        self.assertTrue(gateway.update_sensor_interlock(ai_visible=True))
