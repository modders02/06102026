"""Per-camera lifecycle regression tests; no real CCTV or subprocess is started."""
from pathlib import Path
import sys
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

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


    def test_start_defers_audio_instead_of_failing_while_previous_worker_stops(self):
        cam = Camera(id="slot-1", path="cam1", name="Camera 1", rtsp="rtsp://one")
        worker = MagicMock()
        worker.is_alive.return_value = True
        cam.audio_thread = worker
        cam.stop_flag.set()

        with patch.object(cam, "start_video") as start_video, \
                patch.object(cam, "_defer_audio_restart") as defer:
            cam.start()

        start_video.assert_called_once_with()
        defer.assert_called_once_with(worker)
        self.assertTrue(cam.stop_flag.is_set())

    def test_deferred_audio_restart_starts_after_previous_worker_exits(self):
        cam = Camera(id="slot-1", path="cam1", name="Camera 1", rtsp="rtsp://one")
        worker = MagicMock()
        cam.audio_thread = worker
        cam.stop_flag.set()
        cam._audio_restart_pending = True
        cam.enabled = True

        with patch.object(cam, "start_audio") as start_audio:
            cam._restart_audio_after(worker)

        worker.join.assert_called_once_with()
        self.assertIsNone(cam.audio_thread)
        self.assertFalse(cam._audio_restart_pending)
        self.assertFalse(cam.stop_flag.is_set())
        start_audio.assert_called_once_with()

    def test_deferred_audio_restart_does_not_restart_after_disconnect(self):
        cam = Camera(id="slot-1", path="cam1", name="Camera 1", rtsp="rtsp://one")
        worker = MagicMock()
        cam.audio_thread = worker
        cam.stop_flag.set()
        cam._audio_restart_pending = True
        cam.enabled = False

        with patch.object(cam, "start_audio") as start_audio:
            cam._restart_audio_after(worker)

        worker.join.assert_called_once_with()
        self.assertIsNone(cam.audio_thread)
        self.assertFalse(cam._audio_restart_pending)
        self.assertTrue(cam.stop_flag.is_set())
        start_audio.assert_not_called()


if __name__ == "__main__":
    unittest.main()
