"""Regression tests for MediaMTX startup diagnostics and live KWS enrollment."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from msds import api, manager


class FakeProcess:
    def __init__(self, code=None, pid=123):
        self.code = code
        self.pid = pid

    def poll(self):
        return self.code

    def terminate(self):
        self.code = 0

    def wait(self, timeout=None):
        return self.code

    def kill(self):
        self.code = -9


class MediaMtxRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.original = (manager.MEDIAMTX, manager._MEDIAMTX_LOG,
                         manager._MEDIAMTX_ERROR, manager._MEDIAMTX_RETRY_AFTER)
        manager.MEDIAMTX = None
        manager._MEDIAMTX_LOG = None
        manager._MEDIAMTX_ERROR = None
        manager._MEDIAMTX_RETRY_AFTER = 0

    def tearDown(self):
        log = manager._MEDIAMTX_LOG
        (manager.MEDIAMTX, manager._MEDIAMTX_LOG,
         manager._MEDIAMTX_ERROR, manager._MEDIAMTX_RETRY_AFTER) = self.original
        if log and log.is_file():
            log.unlink(missing_ok=True)

    def test_fast_exit_reports_actual_configuration_error(self):
        def spawn(cmd, stdout, stderr, cwd, creationflags):
            stdout.write(b"ERR: yaml: unmarshal errors: unknown field moqHTTP2Address\n")
            stdout.flush()
            return FakeProcess(code=1)

        with patch.object(manager, "resolve_exe", return_value="/tmp/mediamtx"), \
                patch.object(manager.subprocess, "Popen", side_effect=spawn), \
                patch.object(manager.time, "sleep", return_value=None):
            self.assertFalse(manager.start_mediamtx())
            error = manager.mediamtx_last_error()
            self.assertIn("exited with code 1", error)
            self.assertIn("unknown field moqHTTP2Address", error)

    def test_running_process_is_started_once_and_error_clears(self):
        proc = FakeProcess()
        with patch.object(manager, "resolve_exe", return_value="/tmp/mediamtx") as resolution, \
                patch.object(manager.subprocess, "Popen", return_value=proc) as launch, \
                patch.object(manager.time, "sleep", return_value=None):
            self.assertTrue(manager.start_mediamtx())
            self.assertTrue(manager.start_mediamtx())
            self.assertEqual(launch.call_count, 1)
            self.assertEqual(resolution.call_count, 1)
            self.assertTrue(manager.mediamtx_running())
            self.assertIsNone(manager.mediamtx_last_error())

    def test_missing_binary_is_rechecked_after_install(self):
        with patch.object(manager, "resolve_exe", return_value=None) as resolution:
            self.assertFalse(manager.start_mediamtx())
            resolution.assert_called_once_with(
                "mediamtx", "MEDIAMTX_EXE", refresh=True)
        self.assertIn("was not found", manager.mediamtx_last_error())

    def test_startup_errors_are_exposed_by_api_status(self):
        with patch.object(api, "mediamtx_running", return_value=False), \
                patch.object(api, "mediamtx_last_error", return_value="rtsp port 8554 already in use"), \
                patch.object(api, "snapshot", return_value=[]):
            status = api.status()
            self.assertEqual(status["mediamtx"], False)
            self.assertIn("8554", status["mediamtx_error"])
            self.assertIn("8554", status["error"])
            self.assertEqual(status["available_camera_ids"], [])


class EnrollmentPreflightTests(unittest.TestCase):
    @staticmethod
    def camera():
        thread = SimpleNamespace(is_alive=lambda: True)
        return SimpleNamespace(
            id="slot-1", enabled=True, has_audio_track=True,
            audio_thread=thread, audio_connected=True,
            running=lambda: True,
            request_kws_enrollment=lambda label: {
                "state": "waiting", "keyword": label,
            },
        )

    def test_unknown_camera_suggests_registration(self):
        with patch.object(api, "find_camera", return_value=None), \
                patch.object(api, "snapshot", return_value=[]):
            reply = api.kws_enroll("slot-1", "help")
        self.assertFalse(reply["success"])
        self.assertIn("/cameras/sync", reply["error"])
        self.assertEqual(reply["available_camera_ids"], [])

    def test_dead_mediamtx_blocks_enrollment(self):
        camera = self.camera()
        with patch.object(api, "find_camera", return_value=camera), \
                patch.object(api, "mediamtx_running", return_value=False), \
                patch.object(api, "mediamtx_last_error", return_value="bad MediaMTX configuration"):
            reply = api.kws_enroll("slot-1", "help")
        self.assertFalse(reply["success"])
        self.assertIn("configuration", reply["error"])

    def test_missing_microphone_blocks_enrollment(self):
        camera = self.camera()
        camera.audio_connected = False
        with patch.object(api, "find_camera", return_value=camera), \
                patch.object(api, "mediamtx_running", return_value=True):
            reply = api.kws_enroll("slot-1", "help")
        self.assertFalse(reply["success"])
        self.assertIn("PCM audio", reply["error"])

    def test_missing_audio_track_blocks_enrollment(self):
        camera = self.camera()
        camera.has_audio_track = False
        with patch.object(api, "find_camera", return_value=camera), \
                patch.object(api, "mediamtx_running", return_value=True):
            reply = api.kws_enroll("slot-1", "help")
        self.assertFalse(reply["success"])
        self.assertIn("no audio track", reply["error"])

    def test_healthy_camera_can_arm_original_kws_endpoint(self):
        with patch.object(api, "find_camera", return_value=self.camera()), \
                patch.object(api, "mediamtx_running", return_value=True):
            reply = api.kws_enroll("slot-1", "help")
        self.assertTrue(reply["success"])
        self.assertEqual(reply["keyword"], "help")
        self.assertEqual(reply["state"], "waiting")


if __name__ == "__main__":
    unittest.main()
