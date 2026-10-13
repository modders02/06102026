"""Regression coverage for opt-in, fail-closed borderline HELP review."""
import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from msds import kws_verifier
from msds.camera import Camera
from msds.kws_engine import KWS_ENGINE


def candidate(**overrides):
    fields = dict(
        keyword="help", confidence=0.940, runner_up_keyword="ambulance",
        runner_up_confidence=0.9215,
        keyword_scores={"help": 0.94, "ambulance": 0.9215},
        keyword_duration_ratios={"help": 0.921, "ambulance": 1.10},
        class_margin=0.0185, required_margin=0.0600,
        negative_confidence=0.913, negative_second_confidence=0.820,
        negative_mean2_confidence=0.8665,
        negative_top_confidences=[0.913, 0.820], duration_ratio=0.921,
        duration_ms=376, accepted=False, reason="too_close_to_unknown",
    )
    fields.update(overrides)
    return SimpleNamespace(**fields)


class HelpRescueTests(unittest.TestCase):
    def make_camera(self):
        return Camera(id="slot-1", path="cam1", name="CCTV", rtsp="rtsp://example")

    def test_recovery_is_opt_in_and_bounded(self):
        test_decision = candidate()
        for verify_enabled, rescue_enabled in (("1", "0"), ("0", "1"), ("0", "0")):
            with patch.dict(os.environ, {"MSDS_KWS_VERIFY_ASR": verify_enabled,
                                         "MSDS_KWS_HELP_RESCUE": rescue_enabled}):
                self.assertFalse(kws_verifier.eligible_help_rescue(test_decision))
        with patch.dict(os.environ, {"MSDS_KWS_VERIFY_ASR": "1",
                                     "MSDS_KWS_HELP_RESCUE": "1"}):
            self.assertTrue(kws_verifier.eligible_help_rescue(test_decision))
            for change in (
                {"keyword": "fire"}, {"runner_up_keyword": "fire"},
                {"reason": "below_threshold"}, {"reason": "negative_not_ready"},
                {"reason": "duration_mismatch"}, {"confidence": 0.87},
                {"negative_confidence": 0.925}, {"class_margin": 0.005},
                {"class_margin": 0.06}, {"duration_ratio": 0.60},
                {"duration_ratio": 1.50}, {"accepted": True},
            ):
                with self.subTest(change=change):
                    self.assertFalse(kws_verifier.eligible_help_rescue(candidate(**change)))

    def test_rescue_requires_isolated_word(self):
        self.assertTrue(kws_verifier.isolated_help("Help!"))
        for spoken in ("fine", "hello", "health", "please help", "help me",
                       "help help", "fire", ""):
            self.assertFalse(kws_verifier.isolated_help(spoken))

    def process(self, decision, verification, rescue="1"):
        cam = self.make_camera()
        segment = b"\x01\x00" * 7000
        with patch.dict(os.environ, {"MSDS_KWS_VERIFY_ASR": "1",
                                     "MSDS_KWS_HELP_RESCUE": rescue}), \
             patch.object(KWS_ENGINE, "has_ready_templates", return_value=True), \
             patch.object(cam.kws_segmenter, "feed", return_value=[segment]), \
             patch.object(KWS_ENGINE, "diagnose", return_value=decision), \
             patch.object(kws_verifier, "verify_kws_segment", return_value=verification) as verify:
            cam._process_custom_kws_pcm(b"pcm")
        return cam, verify

    def test_help_near_miss_is_published_only_after_exact_asr(self):
        cases = [
            (kws_verifier.Verification(True, "verified", "help"), 1, "verified_help_rescue"),
            (kws_verifier.Verification(False, "verification_mismatch", "hello"), 0, "too_close_to_unknown"),
            (kws_verifier.Verification(True, "verified", "please help"), 0, "too_close_to_unknown"),
            (kws_verifier.Verification(False, "verification_unavailable", error="missing"), 0, "too_close_to_unknown"),
        ]
        for result, count, expected in cases:
            with self.subTest(result=result):
                cam, verify = self.process(candidate(), result)
                verify.assert_called_once()
                self.assertEqual(len(cam.events), count)
                self.assertEqual(cam.kws_last_decision, expected)
                self.assertEqual(cam.kws_original_decision, "too_close_to_unknown")
                self.assertEqual(cam.kws_verification_transcript, result.transcript)
                if count:
                    self.assertEqual(cam.events[0]["keyword"], "help")
                else:
                    self.assertEqual(cam.kws_last_keyword, "")

    def test_noneligible_rejections_skip_asr(self):
        for decision, enabled in (
            (candidate(), "0"),
            (candidate(keyword="fire"), "1"),
            (candidate(reason="below_threshold"), "1"),
            (candidate(reason="duration_mismatch"), "1"),
            (candidate(negative_confidence=0.937), "1"),
        ):
            with self.subTest(decision=decision, enabled=enabled):
                cam, verify = self.process(
                    decision, kws_verifier.Verification(True, "verified", "help"), enabled
                )
                verify.assert_not_called()
                self.assertEqual(cam.events, [])
                self.assertEqual(cam.kws_last_decision, decision.reason)


if __name__ == "__main__":
    unittest.main()
