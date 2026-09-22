import unittest
from unittest.mock import patch

import station_gateway as gateway


class ModelSelectionTests(unittest.TestCase):
    def setUp(self):
        self.old_model = gateway.active_model
        self.old_key = gateway.active_model_key
        self.old_generation = gateway.model_generation
        self.old_switching = gateway.model_switching
        self.old_status = gateway.station_status.copy()
        gateway.coordinator.clear()
        gateway.active_model = object()
        gateway.active_model_key = "current"
        gateway.model_switching = False
        gateway.station_status.update(
            online=True, workflowState="IDLE", platformClear=True,
            acceptingItems=True, activeModel="current", modelSwitching=False,
        )

    def tearDown(self):
        gateway.active_model = self.old_model
        gateway.active_model_key = self.old_key
        gateway.model_generation = self.old_generation
        gateway.model_switching = self.old_switching
        gateway.station_status.clear()
        gateway.station_status.update(self.old_status)
        gateway.coordinator.clear()

    def test_successful_switch_replaces_model(self):
        class Candidate:
            names = {0: "paper", 1: "plastic"}

            def predict(self, *_args, **_kwargs):
                return []

        candidate = Candidate()
        with patch.object(gateway, "SIMULATION_MODE", False):
            selected = gateway.select_model("yolov8s-onnx", loader=lambda _path: candidate)
        self.assertEqual(selected, "yolov8s-onnx")
        self.assertIs(gateway.active_model, candidate)
        self.assertEqual(gateway.model_generation, self.old_generation + 1)
        self.assertTrue(gateway.station_status["acceptingItems"])
        self.assertFalse(gateway.station_status["modelSwitching"])

    def test_failed_load_keeps_current_model(self):
        original = gateway.active_model

        def fail(_path):
            raise ValueError("invalid model")

        with patch.object(gateway, "SIMULATION_MODE", False):
            with self.assertRaisesRegex(ValueError, "invalid model"):
                gateway.select_model("yolov8s-onnx", loader=fail)
        self.assertIs(gateway.active_model, original)
        self.assertEqual(gateway.active_model_key, "current")
        self.assertTrue(gateway.station_status["acceptingItems"])
        self.assertFalse(gateway.model_switching)

    def test_busy_platform_blocks_switch(self):
        gateway.station_status["platformClear"] = False
        with patch.object(gateway, "SIMULATION_MODE", False):
            with self.assertRaisesRegex(RuntimeError, "platform is empty"):
                gateway.select_model("yolov8s-onnx", loader=lambda _path: None)
        self.assertEqual(gateway.active_model_key, "current")

    def test_export_without_paper_and_plastic_is_rejected(self):
        class Candidate:
            names = {0: "metal", 1: "glass"}

            def predict(self, *_args, **_kwargs):
                return []

        original = gateway.active_model
        with patch.object(gateway, "SIMULATION_MODE", False):
            with self.assertRaisesRegex(ValueError, "paper and plastic"):
                gateway.select_model("yolov8s-onnx", loader=lambda _path: Candidate())
        self.assertIs(gateway.active_model, original)


if __name__ == "__main__":
    unittest.main()
