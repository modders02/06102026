"""Local manual V4.1 audio audit tests; synth only, never reads real recordings."""
from __future__ import annotations

import csv
import hashlib
from pathlib import Path
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from audit_noise_kws_v41_playback import (
    COLUMNS, GROUPS, append_review, ask_rating, audio_diagnostics,
    load_reviews, recording_file, select_rows,
)
from train_noise_augmented_kws import SAMPLE_RATE


def row(expected, top, accepted):
    return {
        "file": f"train/{expected}/{expected}-synthetic.wav",
        "expected": expected,
        "raw_top_class": top,
        "accepted_class": accepted,
    }


class V41PlaybackReviewTests(unittest.TestCase):
    def test_review_groups_are_disjoint_and_comprehensive(self):
        entries = [
            row("help", "fire", "unknown"),
            row("emergency", "unknown", "unknown"),
            row("danger", "danger", "unknown"),
            row("fire", "fire", "fire"),
            row("unknown", "police", "unknown"),
            row("unknown", "unknown", "unknown"),
        ]
        self.assertEqual(len(select_rows(entries, "wrong-top")), 2)
        self.assertEqual(len(select_rows(entries, "correct-rejected")), 1)
        self.assertEqual(len(select_rows(entries, "unknown-suspicious")), 1)
        self.assertEqual(len(select_rows(entries, "accepted-control")), 1)
        self.assertEqual(len(select_rows(entries, "all")), len(entries))
        with self.assertRaisesRegex(ValueError, "Unknown review group"):
            select_rows(entries, "accept-all")
        self.assertIn("wrong-top", GROUPS)

    def test_path_validation_and_source_hash(self):
        with tempfile.TemporaryDirectory() as rootstr:
            root = Path(rootstr)
            base = root / "fresh"
            valid = row("help", "fire", "unknown")
            expected = base / "train" / "help" / "help-synthetic.wav"
            expected.parent.mkdir(parents=True)
            expected.write_bytes(b"synthetic-wav-header-is-not-decoded-here")
            source, digest = recording_file(base, valid)
            self.assertEqual(source, expected)
            self.assertEqual(digest, hashlib.sha256(expected.read_bytes()).hexdigest())
            for bad in [
                "train/unknown/help-synthetic.wav",
                "train/help/../escape.wav",
                "../help/help-synthetic.wav",
                "train\\help\\help-synthetic.wav",
                "train/help/not-wav.txt",
            ]:
                changed = dict(valid, file=bad)
                with self.assertRaises(ValueError):
                    recording_file(base, changed)
            expected.unlink()
            with self.assertRaisesRegex(ValueError, "Missing/symlink"):
                recording_file(base, valid)

    def test_audio_diagnostics_full_vs_context_no_source_mutation(self):
        t = np.arange(SAMPLE_RATE * 2, dtype=np.float32) / SAMPLE_RATE
        samples = (0.15 * np.sin(2 * np.pi * 250 * t)).astype(np.float32)
        untouched = samples.copy()
        extracted, stats = audio_diagnostics(samples, 0.3, 1.6)
        self.assertEqual(len(extracted), round(1.3 * SAMPLE_RATE))
        self.assertEqual(stats["full_seconds"], 2)
        self.assertAlmostEqual(stats["selected_fraction"], 0.65, places=3)
        self.assertGreater(stats["full_rms"], 0.01)
        np.testing.assert_array_equal(samples, untouched)
        extracted[:] = 0
        np.testing.assert_array_equal(samples, untouched)
        with self.assertRaisesRegex(ValueError, "Invalid V4.1 crop bounds"):
            audio_diagnostics(samples, 1.5, 3.0)

    def test_review_csv_is_append_only_and_resumable(self):
        with tempfile.TemporaryDirectory() as rootstr:
            report = Path(rootstr) / "review.csv"
            self.assertEqual(load_reviews(report), {})
            value = {
                "file": "train/fire/test.wav",
                "sha256": "a" * 64,
                "expected": "fire",
                "review_group": "wrong-top",
                "original_seconds": "2.5",
                "selected_start_s": "0.5",
                "selected_end_s": "1.9",
                "selected_seconds": "1.4",
                "original_expected_word_audible": "Y",
                "selected_expected_word_complete": "N",
                "quality": "S",
            }
            append_review(report, value)
            self.assertEqual(load_reviews(report), {value["file"]: value})
            with report.open("r", encoding="utf-8") as f:
                self.assertEqual(tuple(csv.DictReader(f).fieldnames), COLUMNS)
            append_review(report, dict(value, file="train/help/test2.wav"))
            self.assertEqual(len(load_reviews(report)), 2)
            append_review(report, value)
            with self.assertRaisesRegex(ValueError, "Duplicate"):
                load_reviews(report)

    def test_ratings_replay_without_writing(self):
        from unittest.mock import patch
        replayed = []
        with patch("builtins.input", side_effect=["R", "maybe", "Y"]):
            rating = ask_rating("Did you hear the word?", "YNU", lambda: replayed.append(1))
        self.assertEqual(rating, "Y")
        self.assertEqual(len(replayed), 1)
        with patch("builtins.input", return_value="Q"):
            self.assertEqual(ask_rating("prompt", "YNU", lambda: None), "Q")


if __name__ == "__main__":
    unittest.main()
