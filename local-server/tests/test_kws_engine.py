"""Unit tests for the custom MSDS keyword spotter; no microphone is required."""
from pathlib import Path
import math
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from msds.kws_engine import (
    CustomKeywordEngine,
    MIN_NEGATIVE_TEMPLATES,
    MIN_TEMPLATES,
    MATCH_MARGIN,
    OPEN_SET_MARGIN,
    SAMPLE_RATE,
    StreamingSpeechSegmenter,
)


def synthetic_word(pattern, scale=1.0) -> bytes:
    """Create a deterministic speech-like sequence with changing formants."""
    pieces = [np.zeros(int(SAMPLE_RATE * 0.08), dtype=np.float32)]
    for index, freq in enumerate(pattern):
        duration = 0.18 + index * 0.015
        count = int(SAMPLE_RATE * duration)
        t = np.arange(count, dtype=np.float32) / SAMPLE_RATE
        f = freq * scale
        # Fundamental + two harmonics with an amplitude envelope.
        signal = (
            0.42 * np.sin(2 * math.pi * f * t)
            + 0.22 * np.sin(2 * math.pi * f * 2.0 * t)
            + 0.10 * np.sin(2 * math.pi * f * 3.1 * t)
        )
        envelope = np.sin(np.linspace(0.05, math.pi - 0.05, count, dtype=np.float32))
        pieces.append(signal * envelope)
        pieces.append(np.zeros(int(SAMPLE_RATE * 0.035), dtype=np.float32))
    pieces.append(np.zeros(int(SAMPLE_RATE * 0.10), dtype=np.float32))
    samples = np.concatenate(pieces)
    return (np.clip(samples, -0.98, 0.98) * 32767).astype("<i2").tobytes()


class CustomKeywordEngineTests(unittest.TestCase):
    def test_streaming_segmenter_emits_after_end_silence(self):
        segmenter = StreamingSpeechSegmenter()
        word = synthetic_word([300, 520, 410])
        stream = (
            np.zeros(int(SAMPLE_RATE * 0.2), dtype="<i2").tobytes()
            + word
            + np.zeros(int(SAMPLE_RATE * 0.4), dtype="<i2").tobytes()
        )

        segments = []
        block_bytes = 4096
        for offset in range(0, len(stream), block_bytes):
            segments.extend(segmenter.feed(stream[offset:offset + block_bytes]))

        self.assertEqual(len(segments), 1)
        self.assertGreater(len(segments[0]), int(SAMPLE_RATE * 0.3) * 2)

    def test_enrollment_requires_three_samples_then_matches_keyword(self):
        with tempfile.TemporaryDirectory() as tmp:
            engine = CustomKeywordEngine(tmp)
            for scale in (0.97, 1.0, 1.03):
                result = engine.enroll("tulong", synthetic_word([310, 560, 430], scale))
            self.assertEqual(result["templates"], MIN_TEMPLATES)
            self.assertTrue(result["ready"])

            for scale in (0.97, 1.0, 1.03):
                engine.enroll("magnanakaw", synthetic_word([760, 360, 880], scale))
            for index, pattern in enumerate((
                [900, 720, 650],
                [520, 810, 690],
                [430, 910, 540],
                [690, 470, 820],
                [830, 610, 930],
            )):
                engine.enroll("unknown", synthetic_word(pattern, 1.0 + index * 0.005))

            match = engine.match(synthetic_word([310, 560, 430], 1.01))
            self.assertIsNotNone(match)
            self.assertEqual(match.keyword, "tulong")
            self.assertGreaterEqual(match.confidence, 0.72)

    def test_templates_persist_across_engine_restart(self):
        with tempfile.TemporaryDirectory() as tmp:
            engine = CustomKeywordEngine(tmp)
            for scale in (0.98, 1.0, 1.02):
                engine.enroll("help", synthetic_word([280, 500, 390], scale))

            reloaded = CustomKeywordEngine(tmp)
            status = reloaded.status()
            self.assertEqual(status["keywords"]["help"], 3)
            self.assertIn("help", status["ready_keywords"])
            self.assertFalse(status["negative_ready"])
            self.assertFalse(status["open_set_ready"])

    def test_open_set_refuses_keyword_until_negative_speech_is_trained(self):
        with tempfile.TemporaryDirectory() as tmp:
            engine = CustomKeywordEngine(tmp)
            for scale in (0.98, 1.0, 1.02):
                engine.enroll("help", synthetic_word([280, 500, 390], scale))

            decision = engine.diagnose(synthetic_word([280, 500, 390], 1.01))
            self.assertIsNotNone(decision)
            self.assertFalse(decision.accepted)
            self.assertEqual(decision.reason, "negative_not_ready")
            self.assertIsNone(engine.match(synthetic_word([280, 500, 390], 1.01)))

    def test_hard_negative_vetoes_similar_non_keyword(self):
        with tempfile.TemporaryDirectory() as tmp:
            engine = CustomKeywordEngine(tmp)
            for scale in (0.98, 1.0, 1.02):
                engine.enroll("help", synthetic_word([280, 500, 390], scale))

            confuser = synthetic_word([300, 520, 410], 1.0)
            for scale in (0.97, 0.985, 1.0, 1.015, 1.03):
                engine.enroll("unknown", synthetic_word([300, 520, 410], scale))

            decision = engine.diagnose(confuser)
            self.assertIsNotNone(decision)
            self.assertFalse(decision.accepted)
            self.assertEqual(decision.reason, "too_close_to_unknown")
            self.assertGreaterEqual(decision.negative_confidence, decision.confidence - OPEN_SET_MARGIN)

    def test_v4_sequence_matcher_preserves_temporal_order(self):
        with tempfile.TemporaryDirectory() as tmp:
            engine = CustomKeywordEngine(tmp)

            for scale in (0.98, 1.0, 1.02):
                engine.enroll("tulong", synthetic_word([300, 560, 410], scale))
                engine.enroll("sunog", synthetic_word([560, 300, 410], scale))

            for index, pattern in enumerate((
                [900, 720, 650],
                [520, 810, 690],
                [430, 910, 540],
                [690, 470, 820],
                [830, 610, 930],
            )):
                engine.enroll("unknown", synthetic_word(pattern, 1.0 + index * 0.005))

            decision = engine.diagnose(synthetic_word([300, 560, 410], 1.01))
            self.assertIsNotNone(decision)
            self.assertEqual(decision.keyword, "tulong")
            self.assertGreater(
                decision.keyword_scores["tulong"],
                decision.keyword_scores["sunog"],
            )
            self.assertIn("tulong", decision.keyword_duration_ratios)
            self.assertIn("sunog", decision.keyword_duration_ratios)

    def test_template_evaluation_compares_v3_and_v4_without_mutation(self):
        with tempfile.TemporaryDirectory() as tmp:
            engine = CustomKeywordEngine(tmp)
            for scale in (0.98, 1.0, 1.02):
                engine.enroll("tulong", synthetic_word([300, 560, 410], scale))
                engine.enroll("sunog", synthetic_word([560, 300, 410], scale))
            for index, pattern in enumerate((
                [900, 720, 650],
                [520, 810, 690],
                [430, 910, 540],
                [690, 470, 820],
                [830, 610, 930],
            )):
                engine.enroll("unknown", synthetic_word(pattern, 1.0 + index * 0.005))

            before = engine.status()["keywords"].copy()
            report = engine.evaluate_templates()
            after = engine.status()["keywords"].copy()

            self.assertEqual(before, after)
            self.assertTrue(report["success"])
            self.assertIn("v3_dtw", report)
            self.assertIn("v4_sequence", report)
            self.assertEqual(report["v3_dtw"]["total"], 6)
            self.assertEqual(report["v4_sequence"]["total"], 6)
            self.assertIn("tulong", report["duration_summary"])
            self.assertIn("sunog", report["duration_summary"])

            status = engine.status()
            self.assertIn("tulong", status["keyword_margins"])
            self.assertIn("sunog", status["keyword_margins"])
            self.assertLessEqual(status["keyword_margins"]["tulong"], MATCH_MARGIN)
            self.assertLessEqual(status["keyword_margins"]["sunog"], MATCH_MARGIN)
            self.assertIn("tulong", status["keyword_margin_calibration"])
            self.assertIn("sunog", status["keyword_margin_calibration"])

    def test_unknown_training_becomes_open_set_ready_but_is_not_a_keyword(self):
        with tempfile.TemporaryDirectory() as tmp:
            engine = CustomKeywordEngine(tmp)
            for scale in (0.98, 1.0, 1.02):
                engine.enroll("help", synthetic_word([280, 500, 390], scale))
            for index, pattern in enumerate((
                [900, 720, 650],
                [520, 810, 690],
                [430, 910, 540],
                [690, 470, 820],
                [830, 610, 930],
            )):
                engine.enroll("unknown", synthetic_word(pattern, 1.0 + index * 0.005))

            status = engine.status()
            self.assertGreaterEqual(status["negative_templates"], MIN_NEGATIVE_TEMPLATES)
            self.assertTrue(status["negative_ready"])
            self.assertTrue(status["open_set_ready"])
            self.assertNotIn("unknown", status["ready_keywords"])

    def test_untrained_engine_returns_no_keyword(self):
        with tempfile.TemporaryDirectory() as tmp:
            engine = CustomKeywordEngine(tmp)
            self.assertIsNone(engine.match(synthetic_word([300, 520, 410])))

    def test_invalid_keyword_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            engine = CustomKeywordEngine(tmp)
            with self.assertRaises(ValueError):
                engine.enroll("../../bad", synthetic_word([300, 520, 410]))


if __name__ == "__main__":
    unittest.main()
