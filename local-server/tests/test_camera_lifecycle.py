"""Per-camera lifecycle regression tests; no real CCTV or subprocess is started."""
import unittest
from unittest.mock import MagicMock, patch

from msds.camera import Camera
from msds import manager


class CameraLifecycleTests(unittest.TestCase):
    def tearDown(self):
        manager.CAMERAS.clear()

    def test_sync_disables_only_requested_camera(self):
        cam1 = Camera(id="slot-1", path="cam1", name="Camera 1", rtsp="rtsp://one")
        cam2 = Camera(id="slot-2", path="cam2", name="Camera 2", rtsp="rtsp://two")
        manager.CAMERAS.update({"slot-1": cam1, "slot-2": cam2})

        with patch.object(cam1, "stop") as stop1, patch.object(cam2, "stop") as stop2:
            manager.sync_cameras([
                {"id": "slot-1", "path": "cam1", "name": "Camera 1",
                 "rtsp": "rtsp://one", "enabled": False},
                {"id": "slot-2", "path": "cam2", "name": "Camera 2",
                 "rtsp": "rtsp://two", "enabled": True},
            ])

        self.assertFalse(cam1.enabled)
        self.assertTrue(cam2.enabled)
        stop1.assert_called_once_with()
        stop2.assert_not_called()

    def test_stop_waits_for_audio_worker_and_clears_transient_state(self):
        cam = Camera(id="slot-1", path="cam1", name="Camera 1", rtsp="rtsp://one")
        video = MagicMock()
        audio = MagicMock()
        video.poll.return_value = None
        audio.poll.return_value = None
        worker = MagicMock()
        worker.is_alive.side_effect = [True, False]

        cam.video_proc = video
        cam.audio_proc = audio
        cam.audio_thread = worker
        cam.audio_connected = True
        cam.audio_chunks = 4
        cam.audio_bytes = 128000
        cam.last_audio_chunk_at = "2026-10-07T00:00:00Z"
        cam.last_transcription_at = "2026-10-07T00:00:01Z"
        cam.last_transcript = "help me"
        cam.audio_source = "mediamtx"
        cam.audio_sources_tried = ["mediamtx"]
        cam.has_audio_track = True
        cam.audio_codec = "opus"
        cam.events = [{"timestamp": "old", "transcript": "help me"}]

        cam.stop()

        video.terminate.assert_called_once_with()
        audio.terminate.assert_called_once_with()
        worker.join.assert_called_once_with(timeout=5)
        self.assertIsNone(cam.video_proc)
        self.assertIsNone(cam.audio_proc)
        self.assertIsNone(cam.audio_thread)
        self.assertFalse(cam.audio_connected)
        self.assertEqual(cam.audio_chunks, 0)
        self.assertEqual(cam.audio_bytes, 0)
        self.assertEqual(cam.last_transcript, "")
        self.assertIsNone(cam.last_transcription_at)
        self.assertIsNone(cam.audio_source)
        self.assertEqual(cam.audio_sources_tried, [])
        self.assertIsNone(cam.has_audio_track)
        self.assertIsNone(cam.audio_codec)
        self.assertEqual(cam.events, [])


    def test_start_refuses_to_overlap_a_previous_audio_worker(self):
        cam = Camera(id="slot-1", path="cam1", name="Camera 1", rtsp="rtsp://one")
        worker = MagicMock()
        worker.is_alive.return_value = True
        cam.audio_thread = worker
        cam.stop_flag.set()

        with self.assertRaisesRegex(RuntimeError, "Previous audio worker is still stopping"):
            cam.start()

        worker.join.assert_called_once_with(timeout=5)
        self.assertTrue(cam.stop_flag.is_set())


if __name__ == "__main__":
    unittest.main()
