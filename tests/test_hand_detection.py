import json
import queue
import time
import unittest
from unittest.mock import Mock, patch

import station_gateway as g
from station_hands import HandMonitor


class HandMonitorTests(unittest.TestCase):
    def test_partial_overlap_and_clear_interval(self):
        m = HandMonitor((.2, .2, .8, .8))
        m.update([(.1, .3, .21, .5)], 10)
        self.assertFalse(m.present)
        m.update([(.1, .3, .21, .5)], 10.1)
        self.assertTrue(m.present)
        m.update([], 10.2)
        self.assertFalse(m.clear(10.2))
        m.update([], 11.05)
        self.assertTrue(m.clear(11.05))
        self.assertFalse(m.clear(12.1))

    def test_single_false_positive_does_not_interrupt(self):
        m = HandMonitor((0, 0, 1, 1))
        m.update([], 10)
        m.update([(.2, .2, .4, .4)], 10.1)
        self.assertFalse(m.present)
        self.assertFalse(m.clear(10.1))
        m.update([], 10.2)
        self.assertFalse(m.present)
        m.update([(.2, .2, .4, .4)], 10.3)
        self.assertFalse(m.present)
        m.update([(.2, .2, .4, .4)], 10.4)
        self.assertTrue(m.present)

    def test_gap_and_out_of_order_frames_cannot_prove_clear(self):
        m = HandMonitor((0, 0, 1, 1))
        m.update([], 1)
        m.update([], 3)
        self.assertFalse(m.clear(3))
        m.update([(.2,.2,.4,.4)], 2)
        self.assertEqual(m.captured_at, 3)
        m.update([], 3.9)
        self.assertTrue(m.clear(3.9))
        m.error = 'inference failed'
        self.assertFalse(m.clear(3.9))

    def test_hands_outside_roi_do_not_block_and_latest_frame_wins(self):
        m = HandMonitor((.2,.2,.8,.8))
        m.update([(.0,.0,.1,.1)], 1)
        self.assertFalse(m.present)
        m.offer('old', 1)
        m.offer('new', 2)
        self.assertEqual(m.frames.get_nowait(), ('new', 2))


class HandWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.state = g.station_status.copy()
        self.monitor = g.hand_monitor
        self.point_rates = g.POINTS_PER_ITEM.copy()
        g.POINTS_PER_ITEM.update({'Paper': 5, 'Plastic': 10, 'Tin Can': 15})
        g.hand_monitor = None
        g.hand_cancelled_ids.clear()
        g.coordinator.clear()
        g.station_status.update(manualRecoveryRequired=False, handCancellation=False,
            handNotice=None, acceptingItems=True, mixedWasteBlocked=False,
            sensorMixedBlocked=False, inductiveActive=False, binFull=False,
            workflowState='IDLE')

    def tearDown(self):
        g.station_status.clear()
        g.station_status.update(self.state)
        g.hand_monitor = self.monitor
        g.POINTS_PER_ITEM.clear()
        g.POINTS_PER_ITEM.update(self.point_rates)
        g.hand_cancelled_ids.clear()
        g.coordinator.clear()

    def test_hand_forfeits_reward_without_motor_command(self):
        g.coordinator.begin('a')
        g.station_status['workflowState'] = 'SORTING'
        device = Mock()
        g.forfeit_hand_reward('Hand detected')
        g.forfeit_hand_reward('Hand detected again')
        self.assertEqual(list(g.hand_cancelled_ids), ['a'])
        self.assertEqual(g.station_status['workflowState'], 'SORTING')
        device.write.assert_not_called()

    def test_late_sorted_success_after_hand_creates_no_claim(self):
        device = Mock()
        def ack(detection_id, event, timeout):
            if event == 'sorted':
                g.forfeit_hand_reward('Hand detected')
            return {'success': True}
        jobs = queue.Queue()
        with patch.object(g, 'wait_for_event', side_effect=ack), patch.object(g, 'backend_jobs', jobs):
            g.handle_batch(device, {'detectionId':'a','wasteType':'Paper','itemCount':1})
        self.assertTrue(jobs.empty())
        commands = [json.loads(c.args[0])['command'] for c in device.write.call_args_list]
        self.assertEqual(commands, ['prepare', 'sort'])
        self.assertEqual(g.station_status['workflowState'], 'WAITING_FOR_PLATFORM_EMPTY')
        self.assertFalse(g.station_status['acceptingItems'])

    def test_normal_sort_still_creates_claim(self):
        device=Mock()
        jobs=queue.Queue()
        with patch.object(g,'wait_for_event',return_value={'success':True}), patch.object(g,'backend_jobs',jobs):
            g.handle_batch(device,{'detectionId':'b','wasteType':'Paper','itemCount':1})
        self.assertEqual(jobs.get_nowait()['batch']['detectionId'],'b')

    def test_forfeited_batch_rearms_after_platform_clear(self):
        device=Mock()
        g.coordinator.begin('a')
        g.hand_cancelled_ids.append('a')
        g.station_status.update(handCancellation=True,handNotice='Hand detected',
                                activeSource='ai_camera',workflowState='WAITING_FOR_PLATFORM_EMPTY',
                                acceptingItems=False)
        g.process_workflow_event(device,{'event':'platform_empty','detectionId':'a','source':'camera_clear'})
        self.assertEqual(json.loads(device.write.call_args.args[0])['command'],'platform_empty')
        self.assertTrue(g.station_status['acceptingItems'])
        self.assertFalse(g.station_status['handCancellation'])
        self.assertIsNone(g.coordinator.active_detection_id)

    def test_canceled_metal_waits_for_inductive_clear_signal(self):
        device=Mock()
        g.coordinator.begin('a')
        g.hand_cancelled_ids.append('a')
        g.station_status.update(handCancellation=True,activeSource='inductive_sensor',
                                workflowState='WAITING_FOR_PLATFORM_EMPTY',acceptingItems=False)
        g.process_workflow_event(device,{'event':'platform_empty','detectionId':'a','source':'camera_clear'})
        device.write.assert_not_called()
        g.process_workflow_event(device,{'event':'platform_empty','detectionId':'a','source':'inductive_sensor'})
        self.assertEqual(device.write.call_count,1)

    def test_new_batch_waits_while_forfeited_batch_active(self):
        device=Mock()
        g.coordinator.begin('a')
        g.station_status.update(handCancellation=True,workflowState='SORTING')
        g.handle_batch(device,{'detectionId':'new','wasteType':'Plastic'})
        device.write.assert_not_called()

if __name__ == '__main__': unittest.main()
