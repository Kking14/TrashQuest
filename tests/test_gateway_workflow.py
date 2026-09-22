import queue
import threading
import time
import unittest
from unittest.mock import Mock, patch
import station_gateway as gateway


class GatewayWorkflowTests(unittest.TestCase):
    def test_mixed_waste_sends_no_motor_commands(self):
        device = Mock()
        with patch.dict(gateway.station_status, mixedWasteBlocked=True):
            gateway.handle_batch(device, {"detectionId": "mixed", "wasteType": "Plastic"})
        device.write.assert_not_called()
        self.assertTrue(gateway.backend_jobs.empty())

    def test_mixed_detected_during_prepare_cancels_sort(self):
        commands = []

        class Device(gateway.SimulationSerial):
            def write(self, data):
                import json
                commands.append(json.loads(data)["command"])
                if commands[-1] == "prepare":
                    gateway.station_status["mixedWasteBlocked"] = True
                return super().write(data)

        with patch.dict(gateway.station_status, mixedWasteBlocked=False):
            gateway.handle_batch(Device(), {"detectionId": "late-mixed", "wasteType": "Plastic"})
        self.assertEqual(commands, ["prepare", "recover"])
        self.assertTrue(gateway.backend_jobs.empty())
        self.assertIsNone(gateway.coordinator.active_detection_id)

    def setUp(self):
        gateway.coordinator.clear()
        gateway.ignored_detection_ids.clear()
        gateway.POINTS_PER_ITEM.update(gateway.SIMULATION_POINT_RATES)
        gateway.station_status.update(acceptingItems=True, binFull=False, workflowState="IDLE", lastError=None,
                                      inductiveActive=False, aiWasteVisible=False, sensorMixedBlocked=False,
                                      mixedWasteBlocked=False, activeSource=None)
        for work_queue in (gateway.workflow_events, gateway.backend_jobs):
            while True:
                try: work_queue.get_nowait()
                except queue.Empty: break
    def test_automatic_sort_preserves_batch_count_and_blocks_duplicate(self):
        batch = {"event": "camera_batch", "detectionId": "batch-1", "wasteType": "Plastic", "itemCount": 3, "confidence": 0.88, "source": "simulation"}
        gateway.handle_batch(gateway.SimulationSerial(), batch)
        self.assertEqual(gateway.backend_jobs.qsize(), 1)
        self.assertEqual(gateway.backend_jobs.get_nowait()["batch"]["itemCount"], 3)
        self.assertFalse(gateway.station_status["acceptingItems"])
        gateway.handle_batch(gateway.SimulationSerial(), dict(batch))
        self.assertTrue(gateway.backend_jobs.empty())

    def test_sort_failure_creates_no_claim(self):
        class FailingSerial(gateway.SimulationSerial):
            def write(self, data):
                import json
                message = json.loads(data)
                if message["command"] == "sort":
                    gateway.workflow_events.put({"event": "sorted", "detectionId": message["detectionId"], "success": False})
                    return len(data)
                return super().write(data)
        gateway.handle_batch(FailingSerial(), {"detectionId": "failed", "wasteType": "Paper", "source": "simulation"})
        self.assertTrue(gateway.backend_jobs.empty())
        self.assertEqual(gateway.station_status["workflowState"], "IDLE")

    def test_mixed_session_counts_three_sequential_throws(self):
        jobs = []
        for index, waste_type in enumerate(("Paper", "Plastic", "Tin Can")):
            gateway.coordinator.clear()
            gateway.station_status["acceptingItems"] = True
            gateway.handle_batch(gateway.SimulationSerial(), {"detectionId": f"item-{index}", "wasteType": waste_type, "itemCount": 1, "source": "simulation"})
            jobs.append(gateway.backend_jobs.get_nowait()["batch"])
        self.assertEqual(sum(item["itemCount"] for item in jobs), 3)
        self.assertEqual(sum(gateway.POINTS_PER_ITEM[item["wasteType"]] * item["itemCount"] for item in jobs), 30)

    def test_extra_inductive_item_during_prompt_does_not_error_session(self):
        gateway.station_status.update(acceptingItems=False)
        start = gateway.sequence
        gateway.handle_batch(gateway.SimulationSerial(), gateway.batch_from_inductive({"detectionId": "extra-can"}))
        gateway.process_workflow_event(gateway.SimulationSerial(), {"event": "error", "detectionId": "extra-can", "message": "Recovery requested by gateway"})
        emitted = [event for event in gateway.events if event["sequence"] > start]
        self.assertFalse(any(event["type"] == "error" for event in emitted))
        self.assertTrue(any(event["type"] == "detection_ignored" for event in emitted))
        self.assertFalse(gateway.station_status["acceptingItems"])
        self.assertTrue(gateway.backend_jobs.empty())

    def test_unrelated_error_does_not_clear_active_batch(self):
        gateway.coordinator.begin("current-batch")
        gateway.process_workflow_event(gateway.SimulationSerial(), {"event": "error", "detectionId": "old-batch"})
        self.assertTrue(gateway.coordinator.matches("current-batch"))
        gateway.process_workflow_event(gateway.SimulationSerial(), {"event": "error", "detectionId": "current-batch"})
        self.assertIsNone(gateway.coordinator.active_detection_id)

    def test_stale_ack_is_ignored(self):
        gateway.workflow_events.put({"event": "sorted", "detectionId": "old", "success": True})
        self.assertIsNone(gateway.wait_for_event("new", "sorted", 0.02))

    def test_plastic_requires_explicit_class(self):
        self.assertEqual(gateway.normalize_class("plastic bottle"), "Plastic")
        self.assertIsNone(gateway.normalize_class("person"))
        self.assertIsNone(gateway.normalize_class("unknown nonmetal object"))

    def test_metal_is_not_classified_by_ai(self):
        self.assertIsNone(gateway.normalize_class("metal"))

    def test_inductive_sensor_creates_tin_can_batch(self):
        batch = gateway.batch_from_inductive({"detectionId": "inductive-123"})
        self.assertEqual(batch["detectionId"], "inductive-123")
        self.assertEqual(batch["wasteType"], "Tin Can")
        self.assertEqual(batch["itemCount"], 1)
        self.assertEqual(batch["source"], "inductive_sensor")


if __name__ == "__main__":
    unittest.main()
