"""Offline KWS noise-power benchmark tests; synthetic data is not field proof."""
from pathlib import Path
import sys
import tempfile
import unittest
import wave
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from msds.kws_audio_filters import pcm_audio_filter, denoise_enabled, selected_profile
from msds.camera import Camera
from msds.binaries import resolve_exe
from benchmark_kws_noise import (apply_profile, noise_power_report, read_pcm_wav,
                                 predicted_word, heldout_report)


def sample_pcm(values):
    return (np.clip(values, -0.99, 0.99) * 32767).astype("<i2").tobytes()


class OfflineNoiseBenchmarkTests(unittest.TestCase):
    def test_default_cctv_filter_is_backward_compatible(self):
        camera = Camera(id="slot-1", path="cam1", name="test", rtsp="rtsp://example/live")
        candidate = {"transport": "tcp", "url": "rtsp://example/live"}
        with patch.dict("os.environ", {"MSDS_KWS_AUDIO_DENOISE": "0", "MSDS_KWS_NOISE_PROFILE": "strong"}):
            cmd = camera._audio_pcm_cmd("ffmpeg", candidate)
        self.assertNotIn("afftdn", cmd[cmd.index("-af") + 1])
        self.assertIn("aresample=16000:async=1:first_pts=0", cmd[cmd.index("-af") + 1])

    def test_stronger_audio_filter_does_not_affect_video(self):
        camera = Camera(id="slot-1", path="cam1", name="test", rtsp="rtsp://example/live")
        candidate = {"transport": "tcp", "url": "rtsp://example/live"}
        with patch.dict("os.environ", {"MSDS_KWS_AUDIO_DENOISE": "1", "MSDS_KWS_NOISE_PROFILE": "strong"}):
            cmd = camera._audio_pcm_cmd("ffmpeg", candidate)
            video = camera._video_cmd("ffmpeg")
        self.assertIn("afftdn=nr=24:nf=-30:tn=1", cmd[cmd.index("-af") + 1])
        self.assertNotIn("afftdn", " ".join(video))

    def test_noise_percentage_is_mean_square_not_waveform_peak(self):
        rng = np.random.default_rng(2026)
        noise = rng.normal(0.0, 0.1, 16000 * 3)
        a = sample_pcm(noise)
        b = sample_pcm(noise * 0.4)
        result = noise_power_report(a, b)
        self.assertAlmostEqual(result["noise_power_reduction_pct"], 84, delta=0.15)
        self.assertGreater(result["attenuation_db"], 7.0)

    def test_silent_reference_is_rejected(self):
        with self.assertRaises(ValueError):
            noise_power_report(sample_pcm(np.zeros(16000 * 3)), sample_pcm(np.zeros(16000 * 3)))

    def test_wav_reader_does_not_accept_mismatched_audio_format(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "bad.wav"
            with wave.open(str(path), "wb") as out:
                out.setnchannels(2)
                out.setsampwidth(2)
                out.setframerate(16000)
                out.writeframes(b"\0" * 64000)
            with self.assertRaisesRegex(ValueError, "mono"):
                read_pcm_wav(path)

    @unittest.skipUnless(resolve_exe("ffmpeg", "FFMPEG_EXE"), "FFmpeg unavailable")
    def test_strong_profile_exceeds_80pct_on_stationary_test_noise(self):
        # This is ONE known synthetic stationary-noise case, never field proof.
        rng = np.random.default_rng(13)
        pcm = sample_pcm(rng.normal(0, 0.035, 16000 * 5))
        processed = apply_profile(resolve_exe("ffmpeg", "FFMPEG_EXE"), pcm, "strong")
        report = noise_power_report(pcm, processed)
        self.assertGreaterEqual(report["noise_power_reduction_pct"], 80.0)


if __name__ == "__main__":
    unittest.main()
