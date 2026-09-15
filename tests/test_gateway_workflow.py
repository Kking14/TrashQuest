import queue
import threading
import time
import unittest
import station_gateway as gateway


class GatewayWorkflowTests(unittest.TestCase):
    def setUp(self):
        gateway.coordinator.clear()
        gateway.POINTS_PER_ITEM.update(gateway.SIMULATION_POINT_RATES)
        gateway.station_status.update(binFull=False, workflowState="IDLE", lastError=None)
        for work_queue in (gateway.workflow_events, gateway.backend_jobs):
            while True:
                try: work_queue.get_nowait()
                except queue.Empty: break
        with gateway.confirmation_lock:
            gateway.pending_confirmations.clear()

    def test_one_batch_creates_one_claim_job(self):
        batch = {"event": "camera_batch", "detectionId": "batch-1", "wasteType": "Plastic", "itemCount": 3, "confidence": 0.88, "source": "simulation"}
        worker = threading.Thread(target=gateway.handle_batch, args=(gateway.SimulationSerial(), batch))
        worker.start()
        confirmation = None
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline and confirmation is None:
            with gateway.confirmation_lock: confirmation = gateway.pending_confirmations.get("batch-1")
            time.sleep(0.005)
        self.assertIsNotNone(confirmation)
        confirmation.put(True)
        worker.join(2)
        self.assertEqual(gateway.backend_jobs.qsize(), 1)
        self.assertEqual(gateway.backend_jobs.get_nowait()["batch"]["itemCount"], 3)
        gateway.handle_batch(gateway.SimulationSerial(), dict(batch))
        self.assertTrue(gateway.backend_jobs.empty())

    def test_confirmation_timeout_recovers(self):
        original = gateway.CONFIRMATION_TIMEOUT
        gateway.CONFIRMATION_TIMEOUT = 0.01
        try:
            gateway.handle_batch(gateway.SimulationSerial(), {"event": "camera_batch", "detectionId": "timeout", "wasteType": "Paper", "itemCount": 1, "confidence": 0.9, "source": "simulation"})
        finally:
            gateway.CONFIRMATION_TIMEOUT = original
        self.assertEqual(gateway.station_status["workflowState"], "WAITING_FOR_PLATFORM_EMPTY")
        self.assertTrue(gateway.backend_jobs.empty())

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
