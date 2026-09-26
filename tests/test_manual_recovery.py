import queue
import unittest
from unittest.mock import Mock, patch

import station_gateway as gateway


class ManualRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.state = gateway.station_status.copy()
        gateway.station_status.update(manualRecoveryRequired=False, acceptingItems=True,
                                      mixedWasteBlocked=False, sensorMixedBlocked=False,
                                      lastError=None, workflowState="SORTING")
        gateway.coordinator.clear()
        self.notice = "Sorting locked. Check the mechanism and return it home, then press ESP32 EN."

    def tearDown(self):
        gateway.station_status.clear()
        gateway.station_status.update(self.state)
        gateway.coordinator.clear()

    def lock(self):
        gateway.handle_controller_recovery({"event": "error", "detectionId": "can-1",
                                            "requiresManualReset": True, "message": self.notice})

    def test_sensor_clear_and_idle_updates_cannot_release_lock(self):
        self.lock()
        gateway.process_workflow_event(Mock(), {"event": "platform_empty", "detectionId": "can-1"})
        gateway.set_workflow("IDLE", "generic timeout")
        self.assertTrue(gateway.station_status["manualRecoveryRequired"])
        self.assertFalse(gateway.station_status["acceptingItems"])
        self.assertEqual(gateway.station_status["workflowState"], "ERROR_RECOVERY")
        self.assertEqual(gateway.station_status["lastError"], self.notice)

    def test_new_camera_and_metal_batches_send_no_commands_while_locked(self):
        self.lock()
        device = Mock()
        for waste in ("Paper", "Plastic", "Tin Can"):
            gateway.handle_batch(device, {"detectionId": waste, "wasteType": waste})
        device.write.assert_not_called()
        self.assertIsNone(gateway.wait_for_event("can-1", "sorted", 30))

    def test_fresh_ready_releases_lock(self):
        self.lock()
        gateway.coordinator.begin("can-1")
        gateway.handle_controller_recovery({"event": "ready", "state": "IDLE", "success": True})
        self.assertFalse(gateway.station_status["manualRecoveryRequired"])
        self.assertTrue(gateway.station_status["acceptingItems"])
        self.assertEqual(gateway.station_status["workflowState"], "IDLE")
        self.assertIsNone(gateway.coordinator.active_detection_id)

    def test_interrupted_sort_does_not_award_points_or_send_another_command(self):
        def acknowledge(detection_id, event, timeout):
            if event == "prepared":
                return {"success": True}
            self.lock()
            return None

        jobs = queue.Queue()
        device = Mock()
        with patch.object(gateway, "wait_for_event", side_effect=acknowledge), \
             patch.object(gateway, "backend_jobs", jobs), \
             patch.dict(gateway.POINTS_PER_ITEM, {"Paper": 5}):
            gateway.handle_batch(device, {"detectionId": "can-1", "wasteType": "Paper"})
        self.assertEqual(device.write.call_count, 2)  # prepare and sort only
        self.assertTrue(jobs.empty())
        self.assertEqual(gateway.station_status["workflowState"], "ERROR_RECOVERY")

    def test_regular_preparation_error_is_not_a_manual_lock(self):
        self.assertFalse(gateway.handle_controller_recovery({"event": "error", "message": "Camera timeout"}))
        self.assertFalse(gateway.station_status["manualRecoveryRequired"])


if __name__ == "__main__":
    unittest.main()
