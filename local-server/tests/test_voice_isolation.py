"""RNNoise speech-isolation tests on original stable DTW/VAD path.

Static checks run without models or a CCTV. Optional integration test uses
the installed FFmpeg plus the pinned model, and otherwise is skipped.
"""
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from msds.binaries import resolve_exe
from msds.camera import Camera
from msds.kws_audio_filters import (
    denoise_enabled, pcm_audio_filter, voice_isolation_mode,
    voice_isolation_model_dir, voice_isolation_model_path,
)
from msds.kws_engine import DEFAULT_KEYWORDS, MATCH_THRESHOLD, MATCH_MARGIN, OPEN_SET_MARGIN
import subprocess


class StableRNNoiseTests(unittest.TestCase):
    def camera(self):
        return Camera(id="slot-1", path="cam1", name="CCTV",
                      rtsp="rtsp://example.invalid/live")

    def test_default_stable_audio_filter_is_not_modified(self):
        with patch.dict(os.environ, {
            "MSDS_KWS_VOICE_ISOLATION": "off",
            "MSDS_KWS_AUDIO_DENOISE": "0",
        }):
            cmd = self.camera()._audio_pcm_cmd(
                "ffmpeg", {"transport": "tcp", "url": "rtsp://example.invalid/live"}
            )
        chain = cmd[cmd.index("-af") + 1]
        self.assertNotIn("arnndn=", chain)
        self.assertNotIn("afftdn=", chain)
        self.assertIn("aresample=16000:async=1:first_pts=0", chain)
        self.assertIn("asetpts=N/SR/TB", chain)

    def test_maximum_neural_filter_runs_before_16k_kws_vad(self):
        with patch.dict(os.environ, {
            "MSDS_KWS_VOICE_ISOLATION": "maximum",
            "MSDS_KWS_AUDIO_DENOISE": "1",
            "MSDS_KWS_NOISE_PROFILE": "strong",
        }):
            cmd = self.camera()._audio_pcm_cmd(
                "ffmpeg", {"transport": "tcp", "url": "rtsp://example.invalid/live"}
            )
            video = self.camera()._video_cmd("ffmpeg")
        chain = cmd[cmd.index("-af") + 1]
        self.assertIn("arnndn=m=sh.rnnn:mix=1", chain)
        self.assertLess(chain.index("aresample=48000"), chain.index("arnndn="))
        self.assertLess(chain.index("arnndn="), chain.index("aresample=16000"))
        self.assertEqual(chain.count("arnndn="), 1)
        self.assertNotIn("afftdn=", chain)
        self.assertNotIn("arnndn=", " ".join(video))
        self.assertEqual(cmd[cmd.index("-ar") + 1], "16000")
        self.assertEqual(cmd[cmd.index("-ac") + 1], "1")

    def test_balanced_mode_blends_neural_output_to_preserve_soft_speech(self):
        with patch.dict(os.environ, {"MSDS_KWS_VOICE_ISOLATION": "balanced"}):
            chain = pcm_audio_filter()
        self.assertIn("arnndn=m=sh.rnnn:mix=0.75", chain)
        self.assertNotIn("afftdn=", chain)

    def test_mode_validation_never_silently_selects_maximum(self):
        with patch.dict(os.environ, {"MSDS_KWS_VOICE_ISOLATION": "maxxx"}):
            self.assertEqual(voice_isolation_mode(), "off")

    def test_original_fft_profiles_remain_supported_with_rnn_off(self):
        with patch.dict(os.environ, {
            "MSDS_KWS_VOICE_ISOLATION": "off",
            "MSDS_KWS_AUDIO_DENOISE": "1",
            "MSDS_KWS_NOISE_PROFILE": "strong",
        }):
            self.assertTrue(denoise_enabled())
            self.assertIn("afftdn=nr=24:nf=-30:tn=1", pcm_audio_filter())
            self.assertNotIn("arnndn=", pcm_audio_filter())

    def test_original_keyword_and_safety_thresholds_unchanged(self):
        self.assertEqual(len(DEFAULT_KEYWORDS), 7)
        self.assertEqual(MATCH_THRESHOLD, 0.70)
        self.assertEqual(MATCH_MARGIN, 0.06)
        self.assertEqual(OPEN_SET_MARGIN, 0.03)

    def test_installer_is_pinned_and_tests_actual_audio_filter(self):
        setup = (Path(__file__).resolve().parents[1] /
                 "setup-voice-isolation.ps1").read_text(encoding="utf-8")
        self.assertIn("f86e9efd3d78ec91b2d18cfd2262fe991fcb1d35", setup)
        self.assertIn("git.exe hash-object", setup)
        self.assertIn("arnndn=m=sh.rnnn:mix=1", setup)
        self.assertIn('MSDS_KWS_VOICE_ISOLATION = $VoiceMode', setup)
        self.assertIn('MSDS_KWS_AUDIO_DENOISE = "0"', setup)

    @unittest.skipUnless(
        resolve_exe("ffmpeg", "FFMPEG_EXE") and os.path.isfile(voice_isolation_model_path()),
        "RNNoise model or FFmpeg unavailable (run start-voice-isolation.cmd -NoLaunch)",
    )
    def test_real_ffmpeg_neural_filter_returns_16k_speech_pcm(self):
        ffmpeg = resolve_exe("ffmpeg", "FFMPEG_EXE")
        with patch.dict(os.environ, {"MSDS_KWS_VOICE_ISOLATION": "maximum"}):
            chain = pcm_audio_filter()
        out = subprocess.run([
            ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", "sine=frequency=350:sample_rate=48000:duration=1",
            "-af", chain, "-ac", "1", "-ar", "16000",
            "-f", "s16le", "pipe:1",
        ], cwd=voice_isolation_model_dir(), capture_output=True, timeout=15)
        self.assertEqual(out.returncode, 0, out.stderr.decode(errors="replace"))
        self.assertGreater(len(out.stdout), 20000)
        self.assertLessEqual(len(out.stdout), 34000)


if __name__ == "__main__":
    unittest.main()
