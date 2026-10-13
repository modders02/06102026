"""HELP-only opt-in 90% fast acceptance, without weakening fire/UNKNOWN gates."""
from __future__ import annotations

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


def decision(**overrides):
    fields = dict(
        keyword="help", confidence=0.900, runner_up_keyword="ambulance",
        runner_up_confidence=0.880,
        keyword_scores={"help": 0.900, "ambulance": 0.880},
        keyword_duration_ratios={"help": 0.91, "ambulance": 0.80},
        class_margin=0.020, required_margin=0.060,
        negative_confidence=0.885, negative_second_confidence=0.79,
        negative_mean2_confidence=0.838,
        negative_top_confidences=[0.885, 0.79], duration_ratio=0.91,
        duration_ms=480, accepted=False, reason="too_close_to_unknown",
    )
    fields.update(overrides)
    return SimpleNamespace(**fields)


class Help90FastAcceptTests(unittest.TestCase):
    @staticmethod
    def env(flag="1"):
        return patch.dict(os.environ, {
            "MSDS_KWS_HELP_90_FAST_ACCEPT": flag,
            "MSDS_KWS_VERIFY_ASR": "1",
            "MSDS_KWS_HELP_RESCUE": "1",
        })

    def test_switch_defaults_off_and_90_threshold_is_inclusive(self):
        with self.env("0"):
            self.assertFalse(kws_verifier.eligible_help_fast_accept(decision()))
        with self.env():
            self.assertTrue(kws_verifier.eligible_help_fast_accept(decision()))
            self.assertTrue(kws_verifier.eligible_help_fast_accept(
                decision(confidence=0.955, reason="insufficient_margin")
            ))
            self.assertTrue(kws_verifier.eligible_help_fast_accept(
                decision(confidence=0.958, reason="accepted")
            ))
            self.assertFalse(kws_verifier.eligible_help_fast_accept(
                decision(confidence=0.899)
            ))

    def test_other_keywords_and_unready_or_invalid_samples_are_blocked(self):
        with self.env():
            for changes in (
                {"keyword": "fire"}, {"keyword": "ambulance"},
                {"reason": "negative_not_ready"},
                {"reason": "duration_mismatch"},
                {"reason": "below_threshold"},
                {"confidence": 0.93, "negative_confidence": 0.94},
                {"confidence": 0.93, "negative_confidence": 0.93},
                {"duration_ratio": 0.58},
                {"duration_ratio": 1.58},
            ):
                with self.subTest(changes=changes):
                    self.assertFalse(kws_verifier.eligible_help_fast_accept(
                        decision(**changes)
                    ))

    def test_help_90_publishes_once_without_waiting_for_whisper(self):
        cam = Camera(id="slot-1", path="cam1", name="Camera 1",
                     rtsp="rtsp://camera")
        pcm = bytes([1, 0]) * 8000
        with self.env(), \
             patch.object(KWS_ENGINE, "has_ready_templates", return_value=True), \
             patch.object(KWS_ENGINE, "diagnose", return_value=decision()), \
             patch.object(cam.kws_segmenter, "feed", return_value=[pcm]), \
             patch.object(kws_verifier, "verify_kws_segment") as asr:
            cam._process_custom_kws_pcm(pcm)
        asr.assert_not_called()
        self.assertEqual(len(cam.events), 1)
        self.assertEqual(cam.events[0]["keyword"], "help")
        self.assertEqual(cam.events[0]["confidence"], 0.9)
        self.assertEqual(cam.kws_last_decision, "accepted_help_90")
        self.assertEqual(cam.kws_original_decision, "too_close_to_unknown")
        self.assertEqual(cam.kws_verification_state, "skipped_help_90")
        self.assertEqual(cam.kws_verification_target, "")
        self.assertEqual(cam.kws_last_keyword, "help")
        with self.env():
            status = cam.status("127.0.0.1")["audio"]["custom_kws"]
        self.assertTrue(status["help_90_fast_accept_enabled"])
        self.assertEqual(status["help_90_fast_accept_threshold"], 0.9)

    def test_below_90_does_not_shortcut_existing_asr(self):
        cam = Camera(id="slot-1", path="cam1", name="Camera 1",
                     rtsp="rtsp://camera")
        pcm = bytes([1, 0]) * 8000
        rejected = decision(confidence=0.899, accepted=True, reason="accepted",
                            negative_confidence=0.70)
        with self.env(), \
             patch.object(KWS_ENGINE, "has_ready_templates", return_value=True), \
             patch.object(KWS_ENGINE, "diagnose", return_value=rejected), \
             patch.object(cam.kws_segmenter, "feed", return_value=[pcm]), \
             patch.object(kws_verifier, "verify_kws_segment",
                          return_value=kws_verifier.Verification(
                              False, "verification_no_speech")) as asr:
            cam._process_custom_kws_pcm(pcm)
        asr.assert_called_once()
        self.assertEqual(cam.events, [])
        self.assertEqual(cam.kws_last_decision, "verification_no_speech")

    def test_unknown_beating_help_never_shortcuts(self):
        cam = Camera(id="slot-1", path="cam1", name="Camera 1",
                     rtsp="rtsp://camera")
        pcm = bytes([1, 0]) * 8000
        candidate = decision(confidence=0.96, negative_confidence=0.98)
        with self.env(), \
             patch.object(KWS_ENGINE, "has_ready_templates", return_value=True), \
             patch.object(KWS_ENGINE, "diagnose", return_value=candidate), \
             patch.object(cam.kws_segmenter, "feed", return_value=[pcm]), \
             patch.object(kws_verifier, "verify_kws_segment",
                          return_value=kws_verifier.Verification(
                              False, "verification_no_speech")) as asr:
            cam._process_custom_kws_pcm(pcm)
        # Legacy HELP rescue is also bounded by a positive UNKNOWN separation.
        asr.assert_not_called()
        self.assertEqual(cam.events, [])
        self.assertEqual(cam.kws_last_decision, "too_close_to_unknown")


if __name__ == "__main__":
    unittest.main()
