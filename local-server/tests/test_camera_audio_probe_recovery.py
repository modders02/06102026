"""RTSP missing-audio recovery tests; no physical camera or network needed."""
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from msds.camera import Camera, probe_streams


def result(*types):
    return {
        "ok": True,
        "streams": [{"codec_type": kind, "codec_name": "aac" if kind == "audio" else "h264"}
                    for kind in types],
        "error": None,
    }


def failed():
    return {"ok": False, "streams": [], "error": "connection unavailable"}


class AudioProbeRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.camera = Camera(id="slot-1", path="cam1", name="Test",
                             rtsp="rtsp://camera.example/live")

    def test_video_only_relay_and_failed_direct_source_are_inconclusive(self):
        with patch.object(self.camera, "running", return_value=True), \
             patch("msds.camera.probe_streams", side_effect=[result("video"), failed(), failed()]) as probe:
            report = self.camera.probe_audio()
        self.assertFalse(report["ok"])
        self.assertIsNone(self.camera.has_audio_track)
        self.assertEqual(probe.call_count, 3)
        self.assertEqual(len(self.camera.audio_probe_results), 3)
        self.assertEqual(self.camera.audio_probe_results[0]["source"], "mediamtx")
        self.assertFalse(self.camera.audio_probe_results[0]["has_audio_track"])
        self.assertIsNone(self.camera.audio_probe_results[1]["has_audio_track"])

    def test_all_successfully_probed_sources_video_only_proves_no_track(self):
        with patch.object(self.camera, "running", return_value=True), \
             patch("msds.camera.probe_streams", side_effect=[result("video")] * 3):
            self.camera.probe_audio()
        self.assertIs(self.camera.has_audio_track, False)
        self.assertIsNone(self.camera.audio_probe_error)

    def test_direct_audio_detected_after_mute_relay(self):
        with patch.object(self.camera, "running", return_value=True), \
             patch("msds.camera.probe_streams", side_effect=[result("video"), result("video", "audio")]) as probe:
            self.camera.probe_audio()
        self.assertIs(self.camera.has_audio_track, True)
        self.assertEqual(self.camera.audio_codec, "aac")
        self.assertEqual(probe.call_count, 2)

    def test_all_probe_failures_do_not_claim_camera_has_no_microphone(self):
        with patch.object(self.camera, "running", return_value=False), \
             patch("msds.camera.probe_streams", side_effect=[failed(), failed()]):
            self.camera.probe_audio()
        self.assertIsNone(self.camera.has_audio_track)
        self.assertIn("attempting", self.camera.audio_probe_error)

    def test_no_rtsp_source_reports_unverified_state(self):
        self.camera.rtsp = ""
        self.camera.probe_audio()
        self.assertIsNone(self.camera.has_audio_track)

    def test_probe_sources_visible_in_camera_status(self):
        with patch.object(self.camera, "running", return_value=False), \
             patch("msds.camera.probe_streams", side_effect=[result("video"), failed()]):
            self.camera.probe_audio()
        status = self.camera.audio_status()
        self.assertEqual(len(status["audio_probe_results"]), 2)
        self.assertEqual(status["audio_probe_results"][0]["source"], "camera-tcp")
        self.assertEqual(status["audio_probe_results"][1]["source"], "camera-udp")

    def test_republisher_has_larger_audio_discovery_window(self):
        cmd = self.camera._video_cmd("ffmpeg")
        self.assertEqual(cmd[cmd.index("-analyzeduration") + 1], "3000000")
        self.assertEqual(cmd[cmd.index("-probesize") + 1], "1048576")
        self.assertIn("0:a:0?", cmd)

    def test_malformed_probe_metadata_is_not_proof_of_missing_audio(self):
        fake = SimpleNamespace(returncode=0, stdout="{broken", stderr="")
        with patch("msds.camera.resolve_exe", return_value="ffprobe"), \
             patch("msds.camera.subprocess.run", return_value=fake):
            data = probe_streams("rtsp://example")
        self.assertFalse(data["ok"])
        self.assertIn("invalid JSON", data["error"])

    def test_empty_stream_list_is_not_proof_of_missing_audio(self):
        fake = SimpleNamespace(returncode=0, stdout=json.dumps({"streams": []}), stderr="")
        with patch("msds.camera.resolve_exe", return_value="ffprobe"), \
             patch("msds.camera.subprocess.run", return_value=fake):
            data = probe_streams("rtsp://example")
        self.assertFalse(data["ok"])
        self.assertIn("did not identify", data["error"])


if __name__ == "__main__":
    unittest.main()
