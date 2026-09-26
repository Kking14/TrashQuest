import unittest
from unittest.mock import Mock, patch

import station_gateway as gateway
from station_detection import Detection, MetalObjectMatcher


class MetalAssociationTests(unittest.TestCase):
    def setUp(self):
        self.saved = gateway.station_status.copy()
        self.matcher = gateway.metal_matcher
        self.clear_since = gateway.sensor_clear_since
        gateway.metal_matcher = MetalObjectMatcher((0.53, 0.41, 0.59, 0.49))
        gateway.station_status.update(inductiveActive=False, aiWasteVisible=False,
                                     mixedWasteBlocked=False, sensorMixedBlocked=False,
                                     activeSource=None, workflowState="IDLE", metalSignalAt=0)
        self.can = Detection("Plastic", 0.92, (0.47, 0.35, 0.65, 0.56))
        self.bottle = Detection("Plastic", 0.9, (0.2, 0.3, 0.4, 0.7))

    def tearDown(self):
        gateway.station_status.clear()
        gateway.station_status.update(self.saved)
        gateway.metal_matcher = self.matcher
        gateway.sensor_clear_since = self.clear_since

    def metal_on(self):
        with patch.object(gateway.time, "monotonic", return_value=1):
            gateway.update_sensor_interlock(metal=True)

    def test_single_misclassified_can_is_excluded_and_stabilized(self):
        gateway.associate_metal([self.can], 0.5)
        self.metal_on()
        self.assertFalse(gateway.mixed_waste_blocked())
        rest, matched, pending, context = gateway.associate_metal([self.can], 1.1)
        self.assertEqual(rest, [])
        self.assertEqual(matched, self.can)
        self.assertTrue(pending)
        gateway.associate_metal([self.can], 1.5)
        self.assertTrue(gateway.station_status['metalCheckReady'])
        self.assertFalse(gateway.mixed_waste_blocked())

    def test_additional_object_blocks_in_both_arrival_orders(self):
        for metal_first in (False, True):
            with self.subTest(metal_first=metal_first):
                gateway.station_status.update(inductiveActive=False, sensorMixedBlocked=False, aiWasteVisible=False)
                gateway.metal_matcher.reset()
                if not metal_first:
                    gateway.associate_metal([self.can, self.bottle], 0.5)
                self.metal_on()
                rest, _, _, _ = gateway.associate_metal([self.can, self.bottle], 1.2)
                self.assertEqual(rest, [self.bottle])
                self.assertTrue(gateway.mixed_waste_blocked())

    def test_ambiguous_overlapping_boxes_are_not_overridden(self):
        self.metal_on()
        second = Detection("Paper", 0.85, (0.5, 0.4, 0.7, 0.6))
        rest, matched, _, _ = gateway.associate_metal([self.can, second], 1.1)
        self.assertEqual(len(rest), 2)
        self.assertIsNone(matched)
        self.assertTrue(gateway.mixed_waste_blocked())

    def test_moving_can_retains_identity_after_sensor_release(self):
        self.metal_on()
        gateway.associate_metal([self.can], 1.1)
        gateway.associate_metal([self.can], 1.5)
        gateway.station_status.update(activeSource="inductive_sensor", workflowState="SORTING")
        gateway.update_sensor_interlock(metal=False)
        moved = Detection("Plastic", 0.9, (0.51, 0.35, 0.69, 0.56))
        rest, matched, _, _ = gateway.associate_metal([moved], 1.6)
        self.assertEqual(rest, [])
        self.assertIsNone(matched)
        self.assertFalse(gateway.mixed_waste_blocked())
        gateway.associate_metal([moved, self.bottle], 1.7)
        self.assertFalse(gateway.mixed_waste_blocked())

    def test_rolling_can_reclassified_after_track_loss_does_not_cancel_sort(self):
        self.metal_on()
        gateway.associate_metal([self.can], 1.1)
        gateway.associate_metal([self.can], 1.5)
        gateway.station_status.update(activeSource="inductive_sensor", workflowState="SORTING")
        gateway.update_sensor_interlock(metal=False)
        moved = Detection("Plastic", 0.9, (0.7, 0.6, 0.9, 0.8))
        rest, matched, _, context = gateway.associate_metal([moved], 2.5)
        self.assertEqual(rest, [])
        self.assertIsNone(matched)
        self.assertTrue(context)
        self.assertFalse(gateway.mixed_waste_blocked())

    def test_unmatched_object_and_lost_track_do_not_get_metal_override(self):
        self.metal_on()
        rest, matched, _, _ = gateway.associate_metal([self.bottle], 1.1)
        self.assertEqual(rest, [self.bottle])
        self.assertIsNone(matched)
        self.assertTrue(gateway.mixed_waste_blocked())

    def test_old_frame_cannot_complete_metal_check(self):
        self.metal_on()
        _, _, pending, _ = gateway.associate_metal([self.can], 0.9)
        self.assertTrue(pending)
        self.assertFalse(gateway.station_status['metalCheckReady'])

    def test_without_metal_paper_and_plastic_still_reach_ai(self):
        rest, matched, pending, context = gateway.associate_metal([self.can, self.bottle], 1.1)
        self.assertEqual(rest, [self.can, self.bottle])
        self.assertIsNone(matched)
        self.assertFalse(context)

    def test_camera_clear_cannot_complete_a_metal_transaction(self):
        gateway.coordinator.begin('can-1')
        gateway.station_status['activeSource'] = 'inductive_sensor'
        device = Mock()
        try:
            gateway.process_workflow_event(device, {'event': 'platform_empty', 'source': 'camera_clear', 'detectionId': 'can-1'})
            self.assertTrue(gateway.coordinator.matches('can-1'))
            device.write.assert_not_called()
        finally:
            gateway.coordinator.clear()
