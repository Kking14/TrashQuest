import unittest
from unittest.mock import Mock, patch
import station_gateway as gateway


class BinFullnessTests(unittest.TestCase):
    def setUp(self):
        self.saved = gateway.station_status.copy()
        gateway.station_status.update(binCompartments={}, binFull=False,
                                      manualRecoveryRequired=False, mixedWasteBlocked=False,
                                      sensorMixedBlocked=False, acceptingItems=True)

    def tearDown(self):
        gateway.station_status.clear()
        gateway.station_status.update(self.saved)

    def report(self, name, full, valid=True):
        return gateway.record_fullness({'binType': name, 'isFull': full,
                                         'readingValid': valid, 'distanceCm': 5 if full else 30})

    def test_either_full_blocks_all_sorting_and_other_empty_does_not_clear_it(self):
        for name, other in [('metal', 'plastic'), ('plastic', 'metal'), ('paper', 'plastic')]:
            gateway.station_status['binCompartments'] = {}
            self.report(name, True)
            self.report(other, False)
            self.assertTrue(gateway.station_status['binFull'])
            device = Mock()
            gateway.handle_batch(device, {'detectionId': 'paper', 'wasteType': 'Paper'})
            device.write.assert_not_called()
            self.report(name, False)
            self.assertFalse(gateway.station_status['binFull'])

    def test_timeout_preserves_full_state(self):
        self.report('metal', True)
        self.report('metal', False, False)
        self.assertTrue(gateway.station_status['binFull'])
        self.assertFalse(gateway.station_status['binCompartments']['metal']['readingValid'])

    def test_invalid_bin_does_not_change_states(self):
        self.assertFalse(self.report('glass', False))
        self.assertEqual(gateway.station_status['binCompartments'], {})

    def test_old_backend_response_cannot_clear_newer_full_reading(self):
        self.report('metal', True)
        response = Mock()
        response.read.return_value = b'{"data": {}}'
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        with patch.object(gateway, 'DEVICE_KEY', 'test'), patch.object(gateway, 'urlopen', return_value=response):
            gateway.report_fullness({'binType': 'plastic', 'isFull': False})
        self.assertTrue(gateway.station_status['binFull'])
