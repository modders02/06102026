"""Regression tests for opt-in robust KWS and synthetic SNR comparison.

These tests do not establish live CCTV recognition accuracy.
"""
import os
import sys
import tempfile
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from compare_kws_snr import compare, mix_at_snr  # noqa: E402
from msds import kws_engine  # noqa: E402
from msds.camera import Camera  # noqa: E402
from msds.kws_audio_filters import (  # noqa: E402
    denoise_enabled, pcm_audio_filter, robust_mode, selected_profile,
    webrtc_requested,
)


def pcm(samples):
    return np.round(np.clip(samples, -0.99, 0.99) * 32767).astype("<i2").tobytes()


class RobustModeTests(unittest.TestCase):
    def test_off_leaves_stable_defaults_in_place(self):
        with patch.dict(os.environ, {
            "MSDS_KWS_ROBUST_MODE": "off", "MSDS_KWS_AUDIO_DENOISE": "0",
            "MSDS_KWS_WEBRTC_VAD": "0", "MSDS_KWS_NOISE_PROFILE": "strong",
        }):
            self.assertEqual(robust_mode(), "off")
            self.assertFalse(denoise_enabled())
            self.assertFalse(webrtc_requested())
            self.assertNotIn("afftdn", pcm_audio_filter())
            vad = kws_engine.StreamingSpeechSegmenter()
            self.assertEqual(vad.vad_backend, "adaptive-energy")

    def test_standard_mode_enables_existing_filter_and_webrtc(self):
        with patch.dict(os.environ, {
            "MSDS_KWS_ROBUST_MODE": "standard", "MSDS_KWS_AUDIO_DENOISE": "0",
            "MSDS_KWS_WEBRTC_VAD": "0", "MSDS_KWS_NOISE_PROFILE": "strong",
        }):
            self.assertEqual(selected_profile(), "standard")
            self.assertTrue(denoise_enabled())
            self.assertTrue(webrtc_requested())
            self.assertIn("afftdn=nr=12:nf=-40:tn=1", pcm_audio_filter())
            with patch.object(kws_engine, "webrtcvad") as fake:
                vad = kws_engine.StreamingSpeechSegmenter()
                self.assertEqual(vad.vad_backend, "webrtc-2")
                fake.Vad.assert_called_once_with(2)

    def test_strong_mode_changes_only_camera_audio_capture(self):
        camera = Camera(id="slot-1", path="cam1", name="trial", rtsp="rtsp://example/live")
        with patch.dict(os.environ, {"MSDS_KWS_ROBUST_MODE": "strong"}):
            audio_cmd = camera._audio_pcm_cmd(
                "ffmpeg", {"transport": "tcp", "url": "rtsp://example/live"}
            )
            video_cmd = camera._video_cmd("ffmpeg")
        self.assertIn("afftdn=nr=24:nf=-30:tn=1",
                      audio_cmd[audio_cmd.index("-af") + 1])
        self.assertNotIn("afftdn", " ".join(video_cmd))

    def test_legacy_switches_remain_supported_without_new_mode(self):
        with patch.dict(os.environ, {
            "MSDS_KWS_ROBUST_MODE": "off", "MSDS_KWS_AUDIO_DENOISE": "1",
            "MSDS_KWS_NOISE_PROFILE": "strong", "MSDS_KWS_WEBRTC_VAD": "1",
        }):
            self.assertTrue(denoise_enabled())
            self.assertTrue(webrtc_requested())
            self.assertEqual(selected_profile(), "strong")

    def test_invalid_mode_does_not_enable_experimental_filter(self):
        with patch.dict(os.environ, {
            "MSDS_KWS_ROBUST_MODE": "typo",
            "MSDS_KWS_AUDIO_DENOISE": "0", "MSDS_KWS_WEBRTC_VAD": "0",
        }):
            self.assertEqual(robust_mode(), "off")
            self.assertFalse(webrtc_requested())
            self.assertFalse(denoise_enabled())


class NoisySpeechSNRTests(unittest.TestCase):
    def test_target_snr_is_measured_from_real_signal_and_noise_power(self):
        rate = kws_engine.SAMPLE_RATE
        t = np.arange(rate, dtype=np.float64) / rate
        speech = 0.15 * np.sin(2 * np.pi * 330 * t)
        noise = np.random.default_rng(7).normal(0, 0.04, rate * 4)
        mixed, start, end = mix_at_snr(pcm(speech), pcm(noise), 10.0, seed=17)
        self.assertEqual(start, rate)
        self.assertEqual(end, 2 * rate)
        values = np.frombuffer(mixed, dtype="<i2").astype(np.float64) / 32767.0
        added_noise = values[start:end] - (
            np.frombuffer(pcm(speech), dtype="<i2").astype(np.float64) / 32767.0
        )
        measured = 10 * np.log10(np.mean(speech ** 2) / np.mean(added_noise ** 2))
        self.assertAlmostEqual(measured, 10, delta=0.15)
        self.assertEqual(mixed, mix_at_snr(pcm(speech), pcm(noise), 10.0, seed=17)[0])

    def test_snr_mix_rejects_silent_and_invalid_recordings(self):
        silence = b"\0\0" * kws_engine.SAMPLE_RATE
        noise = pcm(np.random.default_rng(8).normal(
            0, 0.04, kws_engine.SAMPLE_RATE * 3))
        with self.assertRaises(ValueError):
            mix_at_snr(silence, noise, 10)
        with self.assertRaises(ValueError):
            mix_at_snr(noise[:100], noise, 10)
        with self.assertRaises(ValueError):
            mix_at_snr(noise, noise, float("nan"))

    def test_comparison_reports_unknown_false_accepts_separately(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            rate = kws_engine.SAMPLE_RATE
            waveform = pcm(0.15 * np.sin(
                2 * np.pi * 400 * np.arange(rate) / rate
            ))
            for keyword in (*kws_engine.DEFAULT_KEYWORDS, kws_engine.NEGATIVE_CLASS):
                folder = root / keyword
                folder.mkdir()
                count = 10 if keyword == kws_engine.NEGATIVE_CLASS else 3
                for i in range(count):
                    with wave.open(str(folder / f"{i}.wav"), "wb") as wav:
                        wav.setnchannels(1)
                        wav.setsampwidth(2)
                        wav.setframerate(rate)
                        wav.writeframes(waveform)
            room = pcm(np.random.default_rng(12).normal(0, 0.04, rate * 3))
            with (patch("compare_kws_snr.KWS_ENGINE.status", return_value={"open_set_ready": True}),
                  patch("compare_kws_snr.predicted_word", return_value=("help", "accepted"))):
                report = compare("", root, room, snrs=(10,), profiles=("off",), max_files=10)
        values = report["snr_results"]["10dB"]["off"]
        self.assertTrue(report["adequate_sample_counts"])
        self.assertEqual(values["positive_total"], len(kws_engine.DEFAULT_KEYWORDS) * 3)
        self.assertEqual(values["unknown_total"], 10)
        self.assertEqual(values["unknown_false_accepts"], 10)
        self.assertEqual(values["unknown_false_accept_rate"], 1.0)
        self.assertEqual(values["by_keyword"]["unknown"]["predictions"], {"help": 10})
        self.assertEqual(values["by_keyword"]["unknown"]["wrong_keyword"], 10)
        self.assertEqual(values["by_keyword"]["help"]["predictions"], {"help": 3})
        self.assertEqual(values["by_keyword"]["ambulance"]["wrong_keyword"], 3)
        self.assertFalse(report["production_proven"])


if __name__ == "__main__":
    unittest.main()
