"""Watchdog-style timeout protection for the optional Whisper verifier.

No model downloads, real microphones, or real background camera pipelines.
"""
from __future__ import annotations

import os
import sys
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from msds import kws_verifier
from msds.camera import Camera
from msds.kws_engine import KWS_ENGINE


PCM = bytes([1, 0]) * 7000


class VerifierTimeoutTests(unittest.TestCase):
    def test_slow_decode_times_out_and_new_calls_fail_closed_until_idle(self):
        started = threading.Event()
        release = threading.Event()

        def stall(_pcm, _keyword):
            started.set()
            release.wait(2)
            return kws_verifier.Verification(True, "verified", "help")

        try:
            with patch.object(kws_verifier, "_verify_kws_segment_direct", side_effect=stall), \
                 patch.object(kws_verifier, "verification_timeout_seconds", return_value=0.035):
                first = kws_verifier.verify_kws_segment(PCM, "help")
                self.assertTrue(started.is_set())
                self.assertFalse(first.accepted)
                self.assertEqual(first.state, "verification_timeout")
                self.assertTrue(kws_verifier.verification_in_flight())
                second = kws_verifier.verify_kws_segment(PCM, "help")
                self.assertFalse(second.accepted)
                self.assertEqual(second.state, "verification_busy")
        finally:
            release.set()

        # The abandoned response must not re-publish an old event or leave
        # verifier permanently busy.
        for _ in range(100):
            if not kws_verifier.verification_in_flight():
                break
            threading.Event().wait(0.01)
        self.assertFalse(kws_verifier.verification_in_flight())
        with patch.object(kws_verifier, "_verify_kws_segment_direct",
                          return_value=kws_verifier.Verification(True, "verified", "help")):
            third = kws_verifier.verify_kws_segment(PCM, "help")
        self.assertTrue(third.accepted)
        self.assertEqual(third.state, "verified")

    def test_timeout_configuration_invalid_and_extreme_values(self):
        samples = {
            "": 12.0, "nonsense": 12.0, "nan": 12.0, "inf": 12.0,
            "-4": 2.0, "0.2": 2.0, "30": 30.0, "999": 60.0,
        }
        for configured, expected in samples.items():
            with self.subTest(configured=configured), \
                 patch.dict(os.environ, {"MSDS_KWS_VERIFY_TIMEOUT_SECONDS": configured}):
                self.assertEqual(kws_verifier.verification_timeout_seconds(), expected)

    def test_invalid_audio_returns_without_spawning_worker(self):
        with patch.object(kws_verifier, "_verify_kws_segment_direct") as direct:
            result = kws_verifier.verify_kws_segment(b"bad", "help")
        self.assertEqual(result.state, "verification_invalid_audio")
        direct.assert_not_called()

    def test_camera_timeout_does_not_emit_keyword_or_stay_pending(self):
        decision = SimpleNamespace(
            keyword="help", confidence=0.861,
            runner_up_keyword="ambulance", runner_up_confidence=0.747,
            keyword_scores={"help": 0.861, "ambulance": 0.747},
            keyword_duration_ratios={"help": 1.143, "ambulance": 0.6},
            class_margin=0.1144, required_margin=0.0291,
            negative_confidence=0.762,
            negative_second_confidence=0.60,
            negative_mean2_confidence=0.68,
            negative_top_confidences=[0.762, 0.6],
            duration_ratio=1.143, duration_ms=500,
            accepted=True, reason="accepted",
        )
        cam = Camera(id="slot-1", path="cam1", name="Camera 1", rtsp="rtsp://example")
        with patch.dict(os.environ, {"MSDS_KWS_VERIFY_ASR": "1"}), \
             patch.object(KWS_ENGINE, "has_ready_templates", return_value=True), \
             patch.object(KWS_ENGINE, "diagnose", return_value=decision), \
             patch.object(cam.kws_segmenter, "feed", return_value=[PCM]), \
             patch.object(kws_verifier, "verify_kws_segment",
                          return_value=kws_verifier.Verification(
                              False, "verification_timeout", error="Whisper decode exceeded 12s")):
            cam._process_custom_kws_pcm(b"pcm")
        self.assertEqual(cam.kws_original_decision, "accepted")
        self.assertEqual(cam.kws_last_decision, "verification_timeout")
        self.assertEqual(cam.kws_verification_state, "verification_timeout")
        self.assertEqual(cam.kws_verification_error, "Whisper decode exceeded 12s")
        self.assertEqual(cam.events, [])
        self.assertEqual(cam.kws_last_keyword, "")


if __name__ == "__main__":
    unittest.main()
