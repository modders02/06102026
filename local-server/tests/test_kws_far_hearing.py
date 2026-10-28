"""Far Hearing VAD regression tests. No model download or CCTV required.

Far Hearing only changes segmentation sensitivity; the original enrolled
English KWS decision and false-positive gates remain unchanged.
"""
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from msds import kws_engine
from msds.kws_audio_filters import hearing_profile


def as_pcm(x):
    return (np.clip(x, -0.99, 0.99) * 32767).astype("<i2").tobytes()


def feed(segmenter, audio):
    result = []
    for start in range(0, len(audio), 4096):
        result.extend(segmenter.feed(audio[start:start + 4096]))
    return result


class FarHearingTests(unittest.TestCase):
    def test_normal_profile_is_backward_compatible_default(self):
        with patch.dict(os.environ, {
            "MSDS_KWS_HEARING_PROFILE": "normal",
            "MSDS_KWS_WEBRTC_VAD": "1",
            "MSDS_KWS_WEBRTC_MODE": "3",
        }):
            with patch.object(kws_engine, "webrtcvad") as module:
                vad = kws_engine.StreamingSpeechSegmenter()
                module.Vad.assert_called_once_with(3)
        self.assertEqual(vad.hearing_profile, "normal")
        self.assertEqual(vad.start_confirm_frames, 3)
        self.assertEqual(vad.min_speech_seconds, 0.30)
        self.assertAlmostEqual(vad.pre_roll_seconds, 0.12)
        self.assertAlmostEqual(vad.webrtc_min_rms, 0.007)

    def test_far_profile_uses_more_sensitive_speech_onset(self):
        with patch.dict(os.environ, {
            "MSDS_KWS_HEARING_PROFILE": "far",
            "MSDS_KWS_WEBRTC_VAD": "1",
            "MSDS_KWS_WEBRTC_MODE": "1",
        }):
            with patch.object(kws_engine, "webrtcvad") as module:
                vad = kws_engine.StreamingSpeechSegmenter()
                module.Vad.assert_called_once_with(1)
        self.assertEqual(vad.hearing_profile, "far")
        self.assertEqual(vad.start_confirm_frames, 2)
        # Far mode must preserve lengths learned by the DTW templates.
        self.assertEqual(vad.min_speech_seconds, 0.30)
        self.assertAlmostEqual(vad.pre_roll_seconds, 0.12)
        self.assertAlmostEqual(vad.end_silence_seconds, 0.24)
        self.assertAlmostEqual(vad.webrtc_min_rms, 0.0035)

    def test_far_hearing_preserves_template_compatible_segment_boundaries(self):
        for profile in ("normal", "far"):
            with patch.dict(os.environ, {
                "MSDS_KWS_HEARING_PROFILE": profile,
                "MSDS_KWS_WEBRTC_VAD": "0",
            }):
                vad = kws_engine.StreamingSpeechSegmenter()
            self.assertEqual(vad.min_speech_seconds, kws_engine.MIN_SPEECH_SECONDS)
            self.assertEqual(vad.end_silence_seconds, kws_engine.END_SILENCE_SECONDS)
            self.assertEqual(vad.pre_roll_seconds, kws_engine.PRE_ROLL_SECONDS)

    def test_quiet_word_survives_far_mode_but_normal_gate_rejects_it(self):
        rate = kws_engine.SAMPLE_RATE
        silence = np.zeros(rate // 2, np.float32)
        time = np.arange(int(rate * .46)) / rate
        quiet_voice = 0.0068 * np.sin(2 * np.pi * 250 * time)
        signal = as_pcm(np.concatenate((silence, quiet_voice, silence)))

        def run(profile):
            with patch.dict(os.environ, {
                "MSDS_KWS_HEARING_PROFILE": profile,
                "MSDS_KWS_WEBRTC_VAD": "1",
                "MSDS_KWS_WEBRTC_MODE": "1" if profile == "far" else "3",
            }):
                with patch.object(kws_engine, "webrtcvad") as module:
                    module.Vad.return_value.is_speech.side_effect = (
                        lambda frame, _rate: kws_engine.StreamingSpeechSegmenter._rms(frame) > 0.004
                    )
                    vad = kws_engine.StreamingSpeechSegmenter()
                    return feed(vad, signal)
        self.assertEqual(run("normal"), [])
        far_segments = run("far")
        self.assertEqual(len(far_segments), 1)
        duration = len(far_segments[0]) / (2 * rate)
        self.assertGreaterEqual(duration, 0.26)
        self.assertLess(duration, 1.0)

    def test_far_mode_does_not_treat_non_speech_fan_noise_as_a_word(self):
        noise = as_pcm(np.random.default_rng(42).normal(
            0, 0.04, kws_engine.SAMPLE_RATE * 6
        ))
        with patch.dict(os.environ, {
            "MSDS_KWS_HEARING_PROFILE": "far",
            "MSDS_KWS_WEBRTC_VAD": "1",
            "MSDS_KWS_WEBRTC_MODE": "1",
        }):
            with patch.object(kws_engine, "webrtcvad") as module:
                module.Vad.return_value.is_speech.return_value = False
                vad = kws_engine.StreamingSpeechSegmenter()
                found = feed(vad, noise)
        self.assertEqual(found, [])
        self.assertFalse(vad.active)
        self.assertEqual(vad.max_length_drops, 0)

    def test_far_mode_energy_fallback_rejects_weak_stationary_hum(self):
        noise = as_pcm(np.random.default_rng(7).normal(
            0, 0.005, kws_engine.SAMPLE_RATE * 5
        ))
        with patch.dict(os.environ, {
            "MSDS_KWS_HEARING_PROFILE": "far",
            "MSDS_KWS_WEBRTC_VAD": "1",
        }):
            with patch.object(kws_engine, "webrtcvad", None):
                vad = kws_engine.StreamingSpeechSegmenter()
                found = feed(vad, noise)
        self.assertEqual(found, [])
        self.assertFalse(vad.active)

    def test_training_confidence_and_unknown_veto_remain_original(self):
        self.assertEqual(kws_engine.MATCH_THRESHOLD, 0.70)
        self.assertEqual(kws_engine.MATCH_MARGIN, 0.06)
        self.assertEqual(kws_engine.OPEN_SET_MARGIN, 0.03)
        self.assertEqual(kws_engine.MIN_DURATION_RATIO, 0.60)
        self.assertEqual(kws_engine.MAX_DURATION_RATIO, 1.55)

    def test_explicit_original_adaptive_energy_mode_needs_no_webrtc(self):
        with patch.dict(os.environ, {
            "MSDS_KWS_HEARING_PROFILE": "adaptive",
            "MSDS_KWS_ROBUST_MODE": "off",
            "MSDS_KWS_WEBRTC_VAD": "0",
        }):
            vad = kws_engine.StreamingSpeechSegmenter()
            self.assertEqual(hearing_profile(), "adaptive")
        self.assertEqual(vad.vad_backend, "adaptive-energy")
        self.assertEqual(vad.min_speech_seconds, 0.30)
        self.assertEqual(vad.pre_roll_seconds, 0.12)

    def test_invalid_hearing_profile_falls_back_to_normal(self):
        with patch.dict(os.environ, {"MSDS_KWS_HEARING_PROFILE": "extreme"}):
            self.assertEqual(hearing_profile(), "normal")


if __name__ == "__main__":
    unittest.main()
