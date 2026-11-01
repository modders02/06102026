"""Pure synthetic tests for V4.1 WAV-label quality audit; no real audio data."""
from __future__ import annotations

from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from audit_noise_kws_v41_dataset_quality import (
    classify_review, quality_report,
)
from train_noise_augmented_kws import LABELS


def prediction(label, index):
    return {
        "file": f"train/{label}/{index}.wav",
        "expected": label,
        "raw_top_class": label,
        "accepted_class": label if label != "unknown" else "unknown",
    }


def human(label, audible, preserved, quality):
    return {
        "expected": label,
        "original_expected_word_audible": audible,
        "selected_expected_word_complete": preserved,
        "quality": quality,
    }


class V41DataQualityTests(unittest.TestCase):
    def test_manual_quality_categories_do_not_relabel(self):
        self.assertEqual(
            classify_review("unknown", human("unknown", "Y", "Y", "C")),
            "suspect_unknown_contains_keyword",
        )
        self.assertEqual(
            classify_review("unknown", human("unknown", "Y", "N", "C")),
            "suspect_unknown_contains_keyword_context_missing",
        )
        self.assertEqual(
            classify_review("unknown", human("unknown", "N", "N", "N")),
            "reviewed_no_keyword_noisy",
        )
        self.assertEqual(
            classify_review("danger", human("danger", "N", "N", "N")),
            "positive_source_missing_expected_word",
        )
        self.assertEqual(
            classify_review("police", human("police", "Y", "N", "C")),
            "positive_localization_missing_expected_word",
        )
        self.assertEqual(
            classify_review("emergency", human("emergency", "Y", "Y", "C")),
            "positive_complete_clear",
        )
        self.assertEqual(classify_review("fire", None), "unreviewed")
        self.assertEqual(
            classify_review("fire", human("fire", "U", "U", "U")),
            "uncertain_manual_review",
        )

    def test_report_uses_original_folder_counts_and_flags_contamination(self):
        rows = [prediction(label, 0) for label in LABELS]
        rows.extend(prediction("unknown", n) for n in range(1, 3))
        reviews = {
            "train/help/0.wav": human("help", "Y", "Y", "C"),
            "train/emergency/0.wav": human("emergency", "Y", "Y", "C"),
            "train/danger/0.wav": human("danger", "N", "N", "N"),
            "train/intruder/0.wav": human("intruder", "Y", "Y", "C"),
            "train/police/0.wav": human("police", "N", "N", "N"),
            "train/ambulance/0.wav": human("ambulance", "Y", "Y", "C"),
            "train/unknown/0.wav": human("unknown", "Y", "Y", "C"),
            "train/unknown/1.wav": human("unknown", "Y", "N", "C"),
            "train/unknown/2.wav": human("unknown", "N", "N", "N"),
        }
        result = quality_report(rows, reviews)
        self.assertEqual(result["original_test_wavs"], 10)
        self.assertEqual(result["original_positive_label_wavs"], 7)
        self.assertEqual(result["original_unknown_label_wavs"], 3)
        self.assertEqual(result["total_manual_reviewed"], 9)
        self.assertEqual(result["unreviewed_wavs"], 1)
        self.assertEqual(result["original_unknown_with_keyword_according_to_listener"], 2)
        self.assertEqual(result["original_unknown_without_keyword_according_to_listener"], 1)
        self.assertEqual(result["positive_source_word_missing"], 2)
        self.assertEqual(result["clean_complete_positive_sources_reviewed"], 4)
        self.assertTrue(result["research_only"])
        self.assertFalse(result["corrected_test_accuracy_calculated"])
        self.assertFalse(result["original_wav_or_label_modified"])
        self.assertEqual(result["per_file"][-1]["expected_folder_label"], "unknown")

    def test_stale_or_mislabeled_reviews_rejected(self):
        rows = [prediction("fire", 0)]
        with self.assertRaisesRegex(ValueError, "stale"):
            quality_report(rows, {
                "train/unknown/0.wav": human("unknown", "Y", "Y", "C")
            })
        with self.assertRaisesRegex(ValueError, "disagrees"):
            quality_report(rows, {
                "train/fire/0.wav": human("unknown", "Y", "Y", "C")
            })
        with self.assertRaisesRegex(ValueError, "duplicate"):
            quality_report(rows + rows, {})

    def test_all_55_expected_research_groups_without_recomputing_accuracy(self):
        rows = [
            prediction(word, index) for word in LABELS[:-1] for index in range(5)
        ] + [prediction("unknown", index) for index in range(20)]
        reviews = {}
        for item in rows:
            label = item["expected"]
            file = item["file"]
            index = int(Path(file).stem)
            if label == "unknown":
                reviews[file] = (human(label, "Y", "N" if index == 4 else "Y", "C")
                                 if index < 5 else human(label, "N", "N", "N"))
            elif not (label == "fire" and index in (0, 1, 2, 3)):
                review = (human(label, "N", "N", "N")
                          if (label == "danger" and index == 0 or
                              label == "police" and index == 0) else
                          human(label, "Y", "Y", "C"))
                reviews[file] = review
        result = quality_report(rows, reviews)
        self.assertEqual(result["original_test_wavs"], 55)
        self.assertEqual(result["total_manual_reviewed"], 51)
        self.assertEqual(result["unreviewed_wavs"], 4)
        self.assertEqual(result["original_unknown_with_keyword_according_to_listener"], 5)
        self.assertEqual(result["original_unknown_without_keyword_according_to_listener"], 15)
        self.assertEqual(result["positive_source_word_missing"], 2)
        self.assertEqual(result["clean_complete_positive_sources_reviewed"], 29)


if __name__ == "__main__":
    unittest.main()
