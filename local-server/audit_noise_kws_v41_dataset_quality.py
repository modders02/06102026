"""Join V4.1 frozen predictions to human WAV reviews, without relabeling/retraining.

Metadata-only audit. Previous 55 WAVs are already observed; NEVER use this
analysis as a fresh final test or tune a model/threshold against its results.
Source audio is read ONLY to compare SHA256s of previously reviewed files.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys

from audit_noise_kws_v41_failures import validated_frozen_report
from audit_noise_kws_v41_playback import (
    REVIEW_NAME, RESULT_NAME, load_reviews, recording_file,
)
from evaluate_noise_kws_v41 import resolve_test_root
from noise_kws_v4_model import load_model
from train_noise_augmented_kws import LABELS
from train_noise_kws_v3 import DEFAULT_DATA
from train_noise_kws_v41 import V41_NAME

RESULT = "noise_temporal_context_v41.dataset-quality-audit.json"

def classify_review(expected: str, review: dict | None) -> str:
    """Manual observations, not unqualified ground-truth relabeling."""
    if review is None:
        return "unreviewed"
    full = review["original_expected_word_audible"]
    selected = review["selected_expected_word_complete"]
    quality = review["quality"]
    if full == "U" or selected == "U" or quality == "U":
        return "uncertain_manual_review"
    if expected == "unknown":
        if full == "Y":
            return ("suspect_unknown_contains_keyword_context_missing"
                    if selected == "N" else
                    "suspect_unknown_contains_keyword")
        if full == "N":
            return "reviewed_no_keyword_noisy" if quality == "N" else "reviewed_no_keyword"
        raise ValueError("Invalid UNKNOWN review")
    if full == "N":
        return "positive_source_missing_expected_word"
    if full == "Y" and selected == "N":
        return "positive_localization_missing_expected_word"
    if full == "Y" and selected == "Y":
        return "positive_complete_clear" if quality == "C" else "positive_complete_nonclear"
    raise ValueError("Invalid human source/selection judgments")


def quality_report(entries: list[dict], reviews: dict[str, dict]) -> dict:
    """Pure aggregation from frozen labels/predictions and manual CSV.

    Deliberately does NOT calculate 'corrected' recall/FPR: unknown cases
    require independent verification of actual spoken keyword, intent and
    potential multiple words, and the reviewed set is selection-biased.
    """
    if not entries or len({r["file"] for r in entries}) != len(entries):
        raise ValueError("Original evaluation missing rows or contains duplicate file names")
    expected_by_file = {row["file"]: row for row in entries}
    stale = set(reviews).difference(expected_by_file)
    if stale:
        raise ValueError(f"Manual review refers to stale/unrecognized test files ({len(stale)})")
    for name, review in reviews.items():
        if review["expected"] != expected_by_file[name]["expected"]:
            raise ValueError(f"Manual label disagrees with frozen report: {name}")

    per_file = []
    counts = Counter()
    matrix = defaultdict(Counter)
    reviewed_positive = 0
    review_unknown = 0
    for row in entries:
        name = row["file"]
        human = reviews.get(name)
        expected = row["expected"]
        if expected not in LABELS:
            raise ValueError(f"Unrecognized expected label for {name}")
        category = classify_review(expected, human)
        counts[category] += 1
        matrix[expected][category] += 1
        if human is not None:
            if expected == "unknown":
                review_unknown += 1
            else:
                reviewed_positive += 1
        per_file.append({
            "file": name,
            "expected_folder_label": expected,
            "raw_class": row["raw_top_class"],
            "fixed_gate_class": row["accepted_class"],
            "human_review_status": category,
            "source_expected_or_any_keyword_audible": (
                human["original_expected_word_audible"] if human else None
            ),
            "v41_selected_expected_or_any_keyword_audible": (
                human["selected_expected_word_complete"] if human else None
            ),
            "human_quality": human["quality"] if human else None,
            "action": (
                "needs_independent_spoken-word_and_label_review"
                if category.startswith("suspect_unknown") else
                "needs_independent_source_quality_review"
                if category.startswith("positive_source_missing") else
                "not_validated_for_new_training_or_sealed_testing"
            ),
        })
    positives = sum(row["expected"] != "unknown" for row in entries)
    negatives = sum(row["expected"] == "unknown" for row in entries)
    with_keyword = sum(
        category.startswith("suspect_unknown") and count
        for category, count in counts.items()
    )
    without_keyword = counts["reviewed_no_keyword_noisy"] + counts["reviewed_no_keyword"]
    outstanding = counts["unreviewed"]
    return {
        "status": "v41_manual_dataset_quality_audit",
        "original_test_wavs": len(entries),
        "original_positive_label_wavs": positives,
        "original_unknown_label_wavs": negatives,
        "total_manual_reviewed": len(reviews),
        "positive_manual_reviewed": reviewed_positive,
        "unknown_manual_reviewed": review_unknown,
        "unreviewed_wavs": outstanding,
        "original_unknown_with_keyword_according_to_listener": with_keyword,
        "original_unknown_without_keyword_according_to_listener": without_keyword,
        "clean_complete_positive_sources_reviewed": counts["positive_complete_clear"],
        "positive_source_word_missing": counts["positive_source_missing_expected_word"],
        "positive_localization_word_missing": counts["positive_localization_missing_expected_word"],
        "categories": dict(sorted(counts.items())),
        "per_folder_class": {
            label: dict(sorted(matrix[label].items()))
            for label in LABELS
        },
        "per_file": per_file,
        "research_only": True,
        "retraining_performed": False,
        "model_or_threshold_modified": False,
        "original_wav_or_label_modified": False,
        "corrected_test_accuracy_calculated": False,
        "cautions": [
            "Original UNKNOWN class contains FIVE clips marked with emergency words. They are NOT verified negatives; possible mislabeling or different semantic context.",
            "All 15 keyword-free UNKNOWNs were rated noisy/distorted by the operator; negative set may have confounding acoustic-quality or background differences.",
            "Two originally positive-labeled WAVs were marked as not containing complete expected words; do not quietly exclude or relabel them after model testing.",
            "Listening reviews are subjective, single-operator and not an independently adjudicated ground truth.",
            "All original 55 WAVs were used in previous model comparisons; NEVER treat this audited set as a fresh sealed holdout.",
            "Do not retrain on any of the 55, optimize fixed thresholds based on them, or claim low false alarms per hour.",
        ],
        "next_step": (
            "Independently verify actual spoken words/speaker/session provenance; "
            "collect a NEW consenting multi-speaker development corpus with clean "
            "nonkeyword speech, realistic background noise and hard negatives. "
            "Freeze model changes, then evaluate on a separate newly sealed "
            "multi-speaker test and continuous audio negative windows."
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="V4.1 combined quality audit from original frozen evaluation + human CSV"
    )
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA)
    parser.add_argument("--test-data", type=Path, required=True)
    parser.add_argument("--candidate", type=Path)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--review-csv", type=Path)
    parser.add_argument("--check", action="store_true",
                        help="Print report without writing an artifact")
    args = parser.parse_args()
    root = args.data.resolve()
    test_root = resolve_test_root(root, args.test_data.resolve())
    candidate = (args.candidate or root / "artifacts" / V41_NAME).resolve()
    report_file = (args.report or root / "artifacts" / RESULT_NAME).resolve()
    review_file = (args.review_csv or root / "artifacts" / REVIEW_NAME).resolve()
    try:
        _, metadata = load_model(candidate)
        saved = json.loads(report_file.read_text(encoding="utf-8"))
        entries = validated_frozen_report(saved, metadata)
        reviews = load_reviews(review_file)
        index = {r["file"]: r for r in entries}
        for name, human in reviews.items():
            item = index.get(name)
            if item is None:
                raise ValueError(f"Review has no matching frozen prediction: {name}")
            _, digest = recording_file(test_root, item)
            if human["sha256"] != digest:
                raise ValueError(f"Reviewed audio fingerprint mismatch: {name}")
        summary = quality_report(entries, reviews)
        summary["created_utc"] = datetime.now(timezone.utc).isoformat()
        summary["original_model_version"] = metadata["version"]
        summary["original_model_created_utc"] = metadata["created_utc"]
        summary["original_report"] = str(report_file)
        summary["review_csv"] = str(review_file)
        summary["human_review_sha256"] = hashlib.sha256(review_file.read_bytes()).hexdigest()
        compact = {k: v for k, v in summary.items() if k != "per_file"}
        if args.check:
            print(json.dumps(compact, indent=2))
            return 0
        destination = root / "artifacts" / RESULT
        if destination.exists():
            raise ValueError(f"Write-once report exists; preserve existing audit: {destination}")
        with destination.open("x", encoding="utf-8") as output:
            json.dump(summary, output, indent=2)
        print(json.dumps({**compact, "saved_report": str(destination)}, indent=2))
        return 0
    except (OSError, ValueError, KeyError, TypeError, RuntimeError) as exc:
        print(f"[V4.1 quality] Aborted: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
