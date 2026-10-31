"""Read-only crop audit regression tests; no camera, dataset, or alerts needed."""
from __future__ import annotations

from pathlib import Path
import sys
import unittest

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from diagnose_noise_kws_v3_windows import max_rms_window, summarize_predictions
from train_noise_augmented_kws import SAMPLE_RATE


class SegmentAuditTests(unittest.TestCase):
    def test_peak_rms_crop_is_deterministic_and_input_is_unchanged(self):
        pcm = np.zeros(int(SAMPLE_RATE * 2.5), np.float32)
        pcm[:] = 0.01
        pcm[SAMPLE_RATE:int(1.35 * SAMPLE_RATE)] = 0.6
        original = pcm.copy()
        chunk, start = max_rms_window(
            pcm, int(0.8 * SAMPLE_RATE), int(0.05 * SAMPLE_RATE)
        )
        self.assertEqual(len(chunk), int(0.8 * SAMPLE_RATE))
        self.assertLessEqual(start, SAMPLE_RATE)
        self.assertGreaterEqual(start + len(chunk), int(1.35 * SAMPLE_RATE))
        np.testing.assert_array_equal(pcm, original)
        again, again_start = max_rms_window(
            pcm, int(0.8 * SAMPLE_RATE), int(0.05 * SAMPLE_RATE)
        )
        self.assertEqual(start, again_start)
        np.testing.assert_array_equal(chunk, again)

    def test_short_clip_no_crop_and_last_possible_start_checked(self):
        values = np.linspace(-0.1, 0.1, 200, dtype=np.float32)
        same, start = max_rms_window(values, 250, 40)
        self.assertEqual(start, 0)
        np.testing.assert_array_equal(same, values)
        same[0] = 0.77
        self.assertNotEqual(values[0], same[0])
        long = np.zeros(360, np.float32)
        long[-15:] = 0.9
        crop, start = max_rms_window(long, 100, 27)
        self.assertEqual(start, 260)
        self.assertEqual(len(crop), 100)

    def test_rejects_invalid_audio_or_window_parameters(self):
        with self.assertRaisesRegex(ValueError, "nonempty finite"):
            max_rms_window(np.zeros(0, np.float32), 10, 5)
        with self.assertRaisesRegex(ValueError, "nonempty finite"):
            max_rms_window(np.array([0.1, np.nan]), 1, 1)
        with self.assertRaisesRegex(ValueError, "must be positive"):
            max_rms_window(np.ones(10), 0, 2)

    def test_metrics_do_not_conflate_argmax_and_gate_or_ignore_unknown(self):
        rows = [
            {
                "expected": "police",
                "raw_correct": True,
                "accepted_correct": False,
                "accepted_class": "unknown",
            },
            {
                "expected": "fire",
                "raw_correct": True,
                "accepted_correct": True,
                "accepted_class": "fire",
            },
            {
                "expected": "unknown",
                "raw_correct": False,
                "accepted_correct": False,
                "accepted_class": "fire",
            },
        ]
        report = summarize_predictions(rows, "fake")
        self.assertEqual(report["raw_top_positive_accuracy"], 1.0)
        self.assertEqual(report["fixed_gate_positive_recall"], 0.5)
        self.assertEqual(report["unknown_false_positive_count"], 1)
        self.assertEqual(report["by_label"]["police"]["gated_correct"], 0)
        self.assertEqual(report["by_label"]["fire"]["raw_correct"], 1)


if __name__ == "__main__":
    unittest.main()
