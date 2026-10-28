"""Non-invasive checks for RTSP audio timestamp and Electron shutdown handling.

Tests inspect the FFmpeg argument list and npm script only. No RTSP stream,
camera, Electron process, or downloaded neural model is needed.
"""
import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "local-server"))

from msds.camera import Camera  # noqa: E402
from msds.config import RTSP_PORT  # noqa: E402


class RtspAudioTimestampTests(unittest.TestCase):
    def setUp(self):
        self.cam = Camera(id="slot-1", path="cam1", name="Test", rtsp="rtsp://example/live")

    def test_regenerates_monotonic_publisher_audio_timestamps_by_default(self):
        with patch.dict(os.environ, {"MSDS_RTSP_AUDIO_RETIME": "1"}):
            cmd = self.cam._video_cmd("ffmpeg")
        self.assertIn("-af", cmd)
        self.assertEqual(cmd[cmd.index("-af") + 1], "asetpts=N/SR/TB")
        self.assertEqual(cmd[cmd.index("-c:a") + 1], "libopus")
        self.assertEqual(cmd[cmd.index("-map") + 1], "0:v:0")
        self.assertIn("0:a:0?", cmd)
        self.assertIn("-vf", cmd)
        self.assertEqual(cmd[-1], f"rtsp://127.0.0.1:{RTSP_PORT}/cam1")

    def test_maximum_publisher_denoises_audible_cctv_once(self):
        with patch.dict(os.environ, {
            "MSDS_RTSP_AUDIO_DENOISE_PLAYBACK": "1",
            "MSDS_KWS_ROBUST_MODE": "maximum",
            "MSDS_RTSP_AUDIO_RETIME": "1",
        }):
            publisher = self.cam._video_cmd("ffmpeg")
            relay = self.cam._audio_pcm_cmd("ffmpeg", {
                "label": "mediamtx",
                "transport": "tcp",
                "url": f"rtsp://127.0.0.1:{RTSP_PORT}/cam1",
            })
            direct_fallback = self.cam._audio_pcm_cmd("ffmpeg", {
                "label": "camera-tcp",
                "transport": "tcp",
                "url": self.cam.rtsp,
            })
        publisher_audio = publisher[publisher.index("-af") + 1]
        relay_audio = relay[relay.index("-af") + 1]
        direct_audio = direct_fallback[direct_fallback.index("-af") + 1]
        self.assertEqual(publisher_audio.count("afftdn="), 1)
        self.assertIn("afftdn=nr=97:nf=-30:tn=1", publisher_audio)
        self.assertIn("asetpts=N/SR/TB", publisher_audio)
        self.assertNotIn("afftdn=", relay_audio)
        self.assertIn("aresample=16000", relay_audio)
        self.assertEqual(direct_audio.count("afftdn="), 1)
        self.assertIn("afftdn=nr=97:nf=-30:tn=1", direct_audio)
        self.assertIn("libopus", publisher)
        self.assertIn("pcm_s16le", direct_fallback)

    def test_unfiltered_publisher_preserves_single_kws_filter(self):
        with patch.dict(os.environ, {
            "MSDS_RTSP_AUDIO_DENOISE_PLAYBACK": "0",
            "MSDS_KWS_ROBUST_MODE": "maximum",
            "MSDS_RTSP_AUDIO_RETIME": "1",
        }):
            publisher = self.cam._video_cmd("ffmpeg")
            relay = self.cam._audio_pcm_cmd("ffmpeg", {
                "label": "mediamtx", "transport": "tcp",
                "url": f"rtsp://127.0.0.1:{RTSP_PORT}/cam1",
            })
        self.assertEqual(publisher[publisher.index("-af") + 1], "asetpts=N/SR/TB")
        self.assertEqual(relay[relay.index("-af") + 1].count("afftdn="), 1)

    def test_can_opt_out_for_cameras_with_audio_video_sync_problems(self):
        for value in ("0", "off", "false", "no"):
            with self.subTest(value=value), patch.dict(os.environ, {"MSDS_RTSP_AUDIO_RETIME": value}):
                cmd = self.cam._video_cmd("ffmpeg")
            self.assertNotIn("-af", cmd)
            self.assertIn("libopus", cmd)

    def test_timestamp_repair_does_not_affect_raw_kws_audio_capture(self):
        with patch.dict(os.environ, {"MSDS_RTSP_AUDIO_RETIME": "1"}):
            cmd = self.cam._audio_pcm_cmd("ffmpeg", {"transport": "tcp", "url": self.cam.rtsp})
        self.assertNotIn("asetpts=N/SR/TB", cmd)
        self.assertIn("pcm_s16le", cmd)
        self.assertIn("16000", cmd)

    def test_electron_normal_exit_does_not_make_vite_sigterm_an_error(self):
        package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        runner = package["scripts"]["electron:dev"]
        self.assertIn("concurrently -k --success first", runner)
        self.assertIn("npm run dev", runner)
        self.assertIn("npm run electron:start", runner)
        self.assertIn("wait-on http://localhost:8080", runner)


if __name__ == "__main__":
    unittest.main()
