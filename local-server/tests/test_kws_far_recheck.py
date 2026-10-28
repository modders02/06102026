"""Controlled far-field HELP recheck tests: no trained templates or neural models needed."""
import os
import sys
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from msds.kws_engine import KeywordDecision
from msds.kws_far_recheck import far_recheck_mode, recheck_far_segment

def decision(**changes):
    base = KeywordDecision(
        keyword="help", confidence=0.922, distance=0.078,
        runner_up_keyword="ambulance", runner_up_confidence=0.899,
        keyword_scores={"help": 0.922, "ambulance": 0.899},
        keyword_duration_ratios={"help": 0.794},
        class_margin=0.023, required_margin=0.0291,
        negative_confidence=0.896, negative_second_confidence=0.87,
        negative_mean2_confidence=0.883,
        negative_top_confidences=[0.896, 0.87],
        duration_ratio=0.794, duration_ms=540,
        accepted=False, reason="too_close_to_unknown",
    )
    return replace(base, **changes)


class FarRecheckTests(unittest.TestCase):
    def setUp(self):
        self.pcm = bytes([0, 0]) * (16000 // 2)  # 500 ms synthetic segment

    def test_default_off_and_invalid_fail_closed(self):
        with patch.dict(os.environ, {"MSDS_KWS_FAR_RECHECK": "invalid"}):
            self.assertEqual(far_recheck_mode(), "off")

    def test_off_does_not_rescore(self):
        original = decision()
        engine = Mock()
        result = recheck_far_segment(engine, self.pcm, original=original, mode="off")
        self.assertIs(result.decision, original)
        engine.diagnose.assert_not_called()

    def test_shadow_never_changes_original_decision(self):
        original = decision()
        improved = decision(accepted=True, reason="accepted", confidence=0.95,
                            negative_confidence=0.88, class_margin=0.06)
        engine = Mock()
        engine.diagnose.side_effect = [improved, improved]
        result = recheck_far_segment(engine, self.pcm, original=original, mode="shadow")
        self.assertIs(result.decision, original)
        self.assertTrue(result.candidate_accepted)
        self.assertEqual(result.accepted_trims_ms, (60, 100))
        self.assertEqual(result.attempts, 2)

    def test_strict_requires_two_independent_accepted_windows(self):
        original = decision()
        improved = decision(accepted=True, reason="accepted", confidence=0.95,
                            negative_confidence=0.88, class_margin=0.06)
        engine = Mock()
        engine.diagnose.side_effect = [improved, improved]
        result = recheck_far_segment(engine, self.pcm, original=original, mode="strict")
        self.assertTrue(result.decision.accepted)
        self.assertEqual(result.reason, "recheck_accepted")
        self.assertEqual(engine.diagnose.call_count, 2)

    def test_one_accepted_one_rejected_is_not_rescued(self):
        original = decision()
        improved = decision(accepted=True, reason="accepted", confidence=0.95)
        engine = Mock()
        engine.diagnose.side_effect = [improved, original]
        result = recheck_far_segment(engine, self.pcm, original=original, mode="strict")
        self.assertIs(result.decision, original)
        self.assertFalse(result.candidate_accepted)

    def test_other_keyword_never_rescued(self):
        original = decision(keyword="fire")
        engine = Mock()
        result = recheck_far_segment(engine, self.pcm, original=original, mode="strict")
        self.assertIs(result.decision, original)
        engine.diagnose.assert_not_called()

    def test_low_confidence_never_rescued(self):
        original = decision(confidence=0.83)
        engine = Mock()
        result = recheck_far_segment(engine, self.pcm, original=original, mode="strict")
        self.assertIs(result.decision, original)
        engine.diagnose.assert_not_called()

    def test_original_accepted_does_not_retry(self):
        original = decision(accepted=True, reason="accepted")
        engine = Mock()
        result = recheck_far_segment(engine, self.pcm, original=original, mode="strict")
        self.assertIs(result.decision, original)
        engine.diagnose.assert_not_called()

    def test_duration_out_of_suitable_range_fails_closed(self):
        original = decision(duration_ratio=0.59)
        engine = Mock()
        result = recheck_far_segment(engine, self.pcm, original=original, mode="strict")
        self.assertIs(result.decision, original)
        engine.diagnose.assert_not_called()

    def test_short_segment_not_cropped(self):
        original = decision()
        engine = Mock()
        short_pcm = bytes([0, 0]) * 3200  # 200 ms
        result = recheck_far_segment(engine, short_pcm, original=original, mode="strict")
        self.assertIs(result.decision, original)
        engine.diagnose.assert_not_called()


if __name__ == "__main__":
    unittest.main()
