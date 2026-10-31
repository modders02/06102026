"""Metadata-only context crop audit tests; no real voices or audio playback."""
from __future__ import annotations

import csv
from pathlib import Path
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from audit_noise_kws_v4_context import (
    PADDING_SECONDS, COLUMNS, append_context_review, expand_crop_bounds,
    load_context_reviews, select_incomplete,
)
from train_noise_augmented_kws import SAMPLE_RATE


class V4ContextAuditTests(unittest.TestCase):
    def test_context_adds_both_sides_without_mutating_samples(self):
        x = np.arange(SAMPLE_RATE * 3, dtype=np.float32) * 0.000001
        before = x.copy()
        crop, bounds = expand_crop_bounds(x, 1.0, 1.6)
        self.assertAlmostEqual(bounds["start_s"], 0.45)
        self.assertAlmostEqual(bounds["end_s"], 2.15)
        self.assertAlmostEqual(bounds["duration_s"], 1.70)
        self.assertEqual(len(crop), round(1.7 * SAMPLE_RATE))
        np.testing.assert_array_equal(
            crop, x[round(0.45 * SAMPLE_RATE):round(2.15 * SAMPLE_RATE)]
        )
        np.testing.assert_array_equal(x, before)
        crop[0] = -900
        self.assertNotEqual(crop[0], x[round(0.45 * SAMPLE_RATE)])

    def test_context_clips_safely_to_original_bounds(self):
        x = np.ones(int(2.5 * SAMPLE_RATE), np.float32)
        crop, bounds = expand_crop_bounds(x, 0.0, 2.30)
        self.assertEqual(bounds["start_s"], 0.0)
        self.assertEqual(bounds["end_s"], 2.5)
        self.assertEqual(len(crop), len(x))
        self.assertEqual(bounds["context_seconds"], PADDING_SECONDS)

    def test_invalid_inputs_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "nonempty"):
            expand_crop_bounds(np.zeros(0), 0.1, 0.5)
        with self.assertRaisesRegex(ValueError, "nonempty"):
            expand_crop_bounds(np.array([np.nan]), 0.0, 0.1)
        with self.assertRaisesRegex(ValueError, "Invalid baseline"):
            expand_crop_bounds(np.ones(SAMPLE_RATE), 1.0, 1.1)
        with self.assertRaisesRegex(ValueError, "Invalid baseline"):
            expand_crop_bounds(np.ones(SAMPLE_RATE), 0.5, 0.3)

    def test_only_old_incomplete_reviews_are_selected_and_resume(self):
        validation = [
            {"relative_path": "train/emergency/a.wav", "sha256": "sha-a", "label": "emergency"},
            {"relative_path": "train/fire/b.wav", "sha256": "sha-b", "label": "fire"},
            {"relative_path": "train/intruder/c.wav", "sha256": "sha-c", "label": "intruder"},
        ]
        original = {
            row["relative_path"]: {
                "sha256": row["sha256"],
                "crop_complete_word": choice,
            }
            for row, choice in zip(validation, ("N", "N", "Y"))
        }
        selected = select_incomplete(validation, original, {})
        self.assertEqual([r["label"] for r in selected], ["emergency", "fire"])
        complete = {
            "train/emergency/a.wav": {
                "sha256": "sha-a",
                "context_seconds": str(PADDING_SECONDS),
                "complete_word": "Y",
            }
        }
        remaining = select_incomplete(validation, original, complete)
        self.assertEqual([row["label"] for row in remaining], ["fire"])
        complete["train/fire/b.wav"] = {
            "sha256": "incorrect",
            "context_seconds": str(PADDING_SECONDS),
            "complete_word": "N",
        }
        with self.assertRaisesRegex(ValueError, "different audio/context"):
            select_incomplete(validation, original, complete)

    def test_private_csv_accepts_only_supported_reviews_and_can_resume(self):
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "artifacts" / "context-review.csv"
            row = {
                "relative_path": "train/fire/a.wav", "sha256": "x",
                "label": "fire", "baseline_crop_start_s": "0.7",
                "baseline_crop_end_s": "1.2", "expanded_start_s": "0.15",
                "expanded_end_s": "1.75", "expanded_duration_s": "1.6",
                "context_seconds": str(PADDING_SECONDS), "complete_word": "N",
            }
            append_context_review(out, row)
            self.assertEqual(load_context_reviews(out), {row["relative_path"]: row})
            self.assertEqual(list(Path(td).rglob("*.wav")), [])
            with out.open("r", encoding="utf-8", newline="") as f:
                reader = csv.DictReader(f)
                self.assertEqual(tuple(reader.fieldnames), COLUMNS)
            with out.open("a", encoding="utf-8", newline="") as f:
                writer = csv.DictWriter(f, fieldnames=COLUMNS)
                writer.writerow(row)
            with self.assertRaisesRegex(ValueError, "Duplicate"):
                load_context_reviews(out)


if __name__ == "__main__":
    unittest.main()
