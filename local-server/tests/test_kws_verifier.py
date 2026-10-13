"""Isolated ASR verifier tests; do not download speech models or access CCTV."""
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


class VerificationTests(unittest.TestCase):
    def test_whole_word_matching(self):
        self.assertTrue(kws_verifier._word_match("Fire!", "fire"))
        self.assertTrue(kws_verifier._word_match("Please help me", "help"))
        self.assertFalse(kws_verifier._word_match("Fine.", "fire"))
        self.assertFalse(kws_verifier._word_match("Fire!", "help"))
        self.assertFalse(kws_verifier._word_match("firefighter", "fire"))
        self.assertFalse(kws_verifier._word_match("", "fire"))

    def test_invalid_audio_fails_closed(self):
        self.assertEqual(kws_verifier.verify_kws_segment(b"x", "fire").state,
                         "verification_invalid_audio")

    def test_missing_model_fails_closed(self):
        with patch.object(kws_verifier, "_get_model", side_effect=ImportError("missing")):
            result = kws_verifier.verify_kws_segment(b"\x00\x01" * 4000, "fire")
        self.assertFalse(result.accepted)
        self.assertEqual(result.state, "verification_unavailable")

    def test_asr_mismatch_and_agreement(self):
        samples = b"\x00\x01" * 4000
        for text, expected_state, expected_accepted in [
            ("fine", "verification_mismatch", False),
            ("fire", "verified", True),
            ("", "verification_no_speech", False),
        ]:
            with self.subTest(text=text):
                model = SimpleNamespace(transcribe=lambda *args, **kwargs: (
                    [SimpleNamespace(text=text, avg_logprob=-0.1, no_speech_prob=0.1)], None,
                ))
                with patch.object(kws_verifier, "_get_model", return_value=model):
                    result = kws_verifier.verify_kws_segment(samples, "fire")
                self.assertEqual((result.state, result.accepted),
                                 (expected_state, expected_accepted))

    def test_camera_gate_blocks_unverified_keyword(self):
        cam = Camera(id="slot-1", path="cam1", name="CCTV", rtsp="rtsp://example")
        segment = b"\x01\x00" * 12000
        decision = SimpleNamespace(
            keyword="fire", confidence=0.91, runner_up_keyword="help",
            runner_up_confidence=0.78,
            keyword_scores={"fire": 0.91, "help": 0.78},
            keyword_duration_ratios={"fire": 1.0, "help": 1.0},
            class_margin=0.13, required_margin=0.03,
            negative_confidence=0.70, negative_second_confidence=0.60,
            negative_mean2_confidence=0.65,
            negative_top_confidences=[0.70, 0.60], duration_ratio=1.0,
            duration_ms=750, accepted=True, reason="accepted",
        )
        with patch.dict(os.environ, {"MSDS_KWS_VERIFY_ASR": "1"}), \
             patch.object(KWS_ENGINE, "has_ready_templates", return_value=True), \
             patch.object(cam.kws_segmenter, "feed", return_value=[segment]), \
             patch.object(KWS_ENGINE, "diagnose", return_value=decision), \
             patch.object(kws_verifier, "verify_kws_segment", return_value=kws_verifier.Verification(
                 False, "verification_mismatch", "fine")):
            cam._process_custom_kws_pcm(b"pcm")
        self.assertEqual(cam.events, [])
        self.assertEqual(cam.kws_last_decision, "verification_mismatch")
        self.assertEqual(cam.kws_verification_transcript, "fine")

    def test_camera_gate_publishes_verified_keyword(self):
        cam = Camera(id="slot-1", path="cam1", name="CCTV", rtsp="rtsp://example")
        segment = b"\x01\x00" * 12000
        decision = SimpleNamespace(
            keyword="help", confidence=0.9, runner_up_keyword="fire",
            runner_up_confidence=0.6,
            keyword_scores={"help": 0.9, "fire": 0.6},
            keyword_duration_ratios={"help": 1.0, "fire": 1.0},
            class_margin=0.3, required_margin=0.03,
            negative_confidence=0.3, negative_second_confidence=0.2,
            negative_mean2_confidence=0.25,
            negative_top_confidences=[0.3, 0.2], duration_ratio=1.0,
            duration_ms=750, accepted=True, reason="accepted",
        )
        with patch.dict(os.environ, {"MSDS_KWS_VERIFY_ASR": "1"}), \
             patch.object(KWS_ENGINE, "has_ready_templates", return_value=True), \
             patch.object(cam.kws_segmenter, "feed", return_value=[segment]), \
             patch.object(KWS_ENGINE, "diagnose", return_value=decision), \
             patch.object(kws_verifier, "verify_kws_segment", return_value=kws_verifier.Verification(
                 True, "verified", "help")):
            cam._process_custom_kws_pcm(b"pcm")
        self.assertEqual(len(cam.events), 1)
        self.assertEqual(cam.kws_last_decision, "verified")
        self.assertEqual(cam.events[0]["keyword"], "help")


if __name__ == "__main__":
    unittest.main()
