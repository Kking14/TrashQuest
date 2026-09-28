import json
import queue
import unittest
from unittest.mock import Mock, patch

import station_gateway as gateway
from station_detection import Detection, MetalCountTracker


class MetalCountTrackerTests(unittest.TestCase):
    def setUp(self):
        self.tracker = MetalCountTracker(max_items=5)
        self.can_a = (0.15, 0.20, 0.30, 0.50)
        self.can_b = (0.45, 0.20, 0.60, 0.50)

    def test_two_separate_cans_require_fresh_stable_frames(self):
        for at in (1.0, 1.3, 1.6):
            self.tracker.observe([self.can_a, self.can_b], at)
        self.assertEqual(self.tracker.stable_count(1.7, since=1.0), 2)
        self.assertIsNone(self.tracker.stable_count(2.5, since=1.0))

    def test_changing_or_overlapping_boxes_are_not_counted(self):
        self.tracker.observe([self.can_a], 1.0)
        self.tracker.observe([self.can_a, self.can_b], 1.3)
        self.tracker.observe([self.can_a, self.can_b], 1.6)
        self.assertIsNone(self.tracker.stable_count(1.7, since=1.0))
        self.tracker.reset()
        for at in (2.0, 2.3, 2.6):
            self.tracker.observe([self.can_a, (0.16, 0.21, 0.31, 0.51)], at)
        self.assertIsNone(self.tracker.stable_count(2.7, since=2.0))

    def test_empty_or_too_many_boxes_are_not_counted(self):
        for at in (1.0, 1.3, 1.6):
            self.tracker.observe([], at)
        self.assertIsNone(self.tracker.stable_count(1.7, since=1.0))
        self.tracker.reset()
        boxes = [(index * 0.15, 0.1, index * 0.15 + 0.1, 0.3) for index in range(6)]
        for at in (2.0, 2.3, 2.6):
            self.tracker.observe(boxes, at)
        self.assertIsNone(self.tracker.stable_count(2.7, since=2.0))


class GatewayMetalCountTests(unittest.TestCase):
    def setUp(self):
        gateway.coordinator.clear()
        gateway.ignored_detection_ids.clear()
        gateway.count_rejection_ids.clear()
        self.saved = gateway.station_status.copy()
        gateway.station_status.update(acceptingItems=True, binFull=False, mixedWasteBlocked=False,
                                      sensorMixedBlocked=False, manualRecoveryRequired=False, activeSource=None,
                                      metalCheckReady=True, metalMatched=True, lastInferenceCapturedAt=1e15,
                                      metalCountFailure=None)
        gateway.POINTS_PER_ITEM.update(gateway.SIMULATION_POINT_RATES)
        while True:
            try:
                gateway.backend_jobs.get_nowait()
            except queue.Empty:
                break

    def tearDown(self):
        gateway.coordinator.clear()
        gateway.station_status.clear()
        gateway.station_status.update(self.saved)
        while True:
            try:
                gateway.backend_jobs.get_nowait()
            except queue.Empty:
                break

    def test_unconfirmed_count_never_prepares_or_sorts(self):
        device = Mock()
        start = gateway.sequence
        with patch.object(gateway, 'active_model_key', 'yolo26n-tincan-ncnn'), \
                patch.object(gateway, 'SIMULATION_MODE', False), \
                patch.object(gateway, 'collect_metal_count', return_value=None):
            gateway.handle_batch(device, gateway.batch_from_inductive({'detectionId': 'uncertain'}))
        gateway.process_workflow_event(device, {'event': 'error', 'detectionId': 'uncertain',
                                                'message': 'Recovery requested by gateway'})
        emitted = [event for event in gateway.events if event['sequence'] > start]
        written = b''.join(call.args[0] for call in device.write.call_args_list)
        self.assertIn(b'"recover"', written)
        self.assertNotIn(b'"prepare"', written)
        self.assertNotIn(b'"sort"', written)
        self.assertTrue(any(event['type'] == 'rejected' for event in emitted))
        self.assertFalse(any(event['type'] == 'detection_ignored' for event in emitted))
        self.assertIsNone(gateway.coordinator.active_detection_id)

    def test_metal_box_at_sensor_does_not_hide_separate_plastic(self):
        can = (0.48, 0.35, 0.64, 0.58)
        bottle = Detection('Plastic', 0.9, (0.18, 0.3, 0.34, 0.65))
        gateway.station_status.update(inductiveActive=True, metalSignalAt=0,
                                      workflowState='COLLECTING_METAL')
        with patch.object(gateway, 'active_model_key', 'yolo26s-tincan-onnx'):
            remaining, _, pending, context = gateway.associate_metal([bottle], 1.0, [can])
        self.assertEqual(remaining, [bottle])
        self.assertTrue(context)
        self.assertFalse(pending)
        self.assertTrue(gateway.station_status['metalMatched'])
        self.assertTrue(gateway.mixed_waste_blocked())

    def test_can_may_leave_sensor_during_countdown(self):
        gateway.station_status.update(inductiveActive=False, metalMatched=False)
        with patch.object(gateway, 'METAL_COLLECTION_SECONDS', 0), \
                patch.object(gateway.metal_count_tracker, 'stable_count', return_value=2):
            self.assertEqual(gateway.collect_metal_count('sensor-pulse'), 2)

    def test_separate_plastic_still_blocks_after_sensor_clears(self):
        can = (0.45, 0.30, 0.62, 0.58)
        bottle = Detection('Plastic', 0.9, (0.18, 0.3, 0.34, 0.65))
        gateway.station_status.update(inductiveActive=False, activeSource='inductive_sensor',
                                      workflowState='COLLECTING_METAL', metalSignalAt=0)
        with patch.object(gateway, 'active_model_key', 'yolo26s-tincan-onnx'):
            remaining, _, pending, context = gateway.associate_metal([bottle], 1.0, [can])
        self.assertEqual(remaining, [bottle])
        self.assertTrue(context)
        self.assertFalse(pending)
        self.assertTrue(gateway.mixed_waste_blocked())

    def test_confirmed_two_can_count_reaches_sort_and_claim(self):
        device = Mock()
        gateway.station_status.update(inductiveActive=False, metalMatched=False)
        with patch.object(gateway, 'active_model_key', 'yolo26n-tincan-ncnn'), \
                patch.object(gateway, 'SIMULATION_MODE', False), \
                patch.object(gateway, 'collect_metal_count', return_value=2), \
                patch.object(gateway.metal_count_tracker, 'stable_count', return_value=2), \
                patch.object(gateway, 'wait_for_event', return_value={'success': True}):
            gateway.handle_batch(device, gateway.batch_from_inductive({'detectionId': 'two-cans'}))
        commands = [json.loads(call.args[0]) for call in device.write.call_args_list]
        self.assertEqual([command['command'] for command in commands], ['prepare', 'sort'])
        self.assertEqual(commands[1]['itemCount'], 2)
        self.assertEqual(gateway.backend_jobs.get_nowait()['batch']['itemCount'], 2)


if __name__ == '__main__':
    unittest.main()
