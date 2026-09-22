import queue
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch
import station_gateway as gateway


class CameraPipelineTests(unittest.TestCase):
    def setUp(self):
        gateway.camera_stop.clear()
        while not gateway.camera_frames.empty():
            gateway.camera_frames.get_nowait()

    def tearDown(self):
        gateway.camera_stop.set()

    def test_latest_frame_replaces_unprocessed_frames(self):
        for index in range(100):
            gateway.offer_latest_frame(index, float(index))
        self.assertEqual(gateway.camera_frames.qsize(), 1)
        self.assertEqual(gateway.camera_frames.get_nowait(), (99, 99.0))

    def test_preview_keeps_publishing_while_inference_is_blocked(self):
        entered = threading.Event()
        release = threading.Event()
        preview_advanced = threading.Event()
        class Frame:
            shape = (480, 640, 3)
            def copy(self): return Frame()
        class Camera:
            def read(self): return True, Frame()
        class Model:
            names = {}
            def predict(self, *args, **kwargs):
                entered.set()
                release.wait(3)
                return [SimpleNamespace(boxes=[])]
        published = []
        def encode(*args):
            if entered.is_set():
                published.append(True)
                if len(published) >= 5:
                    preview_advanced.set()
            return True, SimpleNamespace(tobytes=lambda: b'jpeg')
        cv2 = SimpleNamespace(rectangle=lambda *args: None, putText=lambda *args: None,
                              imencode=encode, FONT_HERSHEY_SIMPLEX=0, IMWRITE_JPEG_QUALITY=1)
        with patch.dict('sys.modules', {'cv2': cv2}), patch.object(gateway, 'PREVIEW_FPS', 60):
            preview = threading.Thread(target=gateway.camera_preview_loop, args=(Camera(),))
            inference = threading.Thread(target=gateway.vision_loop, args=(Model(),))
            try:
                preview.start()
                inference.start()
                self.assertTrue(entered.wait(2))
                self.assertTrue(preview_advanced.wait(2), 'Preview froze while AI was busy')
                self.assertLessEqual(gateway.camera_frames.qsize(), 1)
            finally:
                gateway.camera_stop.set()
                release.set()
                preview.join(3)
                inference.join(3)
            self.assertFalse(preview.is_alive())
            self.assertFalse(inference.is_alive())
