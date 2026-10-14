"""Opt-in noisy-room speech VAD and FFmpeg filter regression checks."""
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from msds import kws_engine
from msds.camera import Camera


def _pcm(values):
    return (np.clip(values, -0.99, 0.99) * 32767).astype("<i2").tobytes()


def _audio():
    rng = np.random.default_rng(32)
    length = kws_engine.SAMPLE_RATE * 4
    sig = rng.normal(0, 0.036, length).astype("float32")
    start = kws_engine.SAMPLE_RATE
    length_voice = int(0.47 * kws_engine.SAMPLE_RATE)
    t = np.arange(length_voice) / kws_engine.SAMPLE_RATE
    env = np.sin(np.linspace(0, np.pi, length_voice))
    sig[start:start + length_voice] += (
        0.31 * np.sin(2 * np.pi * 260 * t)
        + 0.09 * np.sin(2 * np.pi * 540 * t)
    ) * env
    return sig


def _segments(segmenter, audio):
    result = []
    for offset in range(0, len(audio), 4096):
        result.extend(segmenter.feed(audio[offset:offset + 4096]))
    return result


class WebRtcNoiseGateTests(unittest.TestCase):
    def test_default_keeps_previous_energy_vad(self):
        with patch.dict(os.environ, {"MSDS_KWS_WEBRTC_VAD": "0"}):
            v = kws_engine.StreamingSpeechSegmenter()
        self.assertEqual(v.vad_backend, "adaptive-energy")

    def test_opt_in_uses_speech_detector_and_rejects_loud_noise(self):
        with patch.dict(os.environ, {"MSDS_KWS_WEBRTC_VAD": "1"}):
            with patch.object(kws_engine, "webrtcvad") as module:
                # A deterministic stand-in lets this integration test check
                # the gating behavior without asserting synthetic sine waves
                # are always recognized as speech by a trained WebRTC VAD.
                module.Vad.return_value.is_speech.side_effect = (
                    lambda frame, _rate: kws_engine.StreamingSpeechSegmenter._rms(frame) >= 0.08
                )
                v = kws_engine.StreamingSpeechSegmenter()
                samples = _audio()
                utterances = _segments(v, _pcm(samples))
        self.assertEqual(v.vad_backend, "webrtc-2")
        self.assertEqual(len(utterances), 1)
        self.assertEqual(v.max_length_drops, 0)
        duration = len(utterances[0]) / (kws_engine.SAMPLE_RATE * 2)
        self.assertGreaterEqual(duration, 0.30)
        self.assertLess(duration, 1.0)
        self.assertGreater(v.noise_floor_rms, 0.025)

    def test_consecutive_noise_does_not_become_keyword(self):
        with patch.dict(os.environ, {"MSDS_KWS_WEBRTC_VAD": "1"}):
            with patch.object(kws_engine, "webrtcvad") as module:
                module.Vad.return_value.is_speech.return_value = False
                v = kws_engine.StreamingSpeechSegmenter()
                noise = np.random.default_rng(9).normal(
                    0, 0.06, kws_engine.SAMPLE_RATE * 8
                )
                utterances = _segments(v, _pcm(noise))
        self.assertEqual(utterances, [])
        self.assertEqual(v.max_length_drops, 0)
        self.assertFalse(v.active)

    def test_missing_optional_package_is_visible_not_silent(self):
        with patch.dict(os.environ, {"MSDS_KWS_WEBRTC_VAD": "1"}):
            with patch.object(kws_engine, "webrtcvad", None):
                v = kws_engine.StreamingSpeechSegmenter()
        self.assertIn("unavailable", v.vad_backend)

    def test_denoise_is_opt_in_and_never_changes_video_command(self):
        camera = Camera(id="slot-1", path="cam1", name="test", rtsp="rtsp://example/live")
        candidate = {"transport": "tcp", "url": "rtsp://example/live"}
        with patch.dict(os.environ, {"MSDS_KWS_AUDIO_DENOISE": "0"}):
            off = camera._audio_pcm_cmd("ffmpeg", candidate)
        with patch.dict(os.environ, {"MSDS_KWS_AUDIO_DENOISE": "1"}):
            on = camera._audio_pcm_cmd("ffmpeg", candidate)
        self.assertIn("aresample=16000:async=1:first_pts=0", off[off.index("-af") + 1])
        self.assertNotIn("afftdn", off[off.index("-af") + 1])
        self.assertIn("afftdn=nr=12:nf=-40:tn=1", on[on.index("-af") + 1])
        self.assertIn("asetpts=N/SR/TB", on[on.index("-af") + 1])
        self.assertEqual(off[:off.index("-af")], on[:on.index("-af")])


if __name__ == "__main__":
    unittest.main()
