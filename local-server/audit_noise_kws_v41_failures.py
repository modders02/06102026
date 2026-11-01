"""Read-only postmortem of a FROZEN V4.1 evaluation: no training, no threshold tuning.

This audit categorizes *why* correctly ranked emergency words failed the
original fixed safety gate. The 55-WAV cohort has already been repeatedly
examined; this is descriptive analysis, NEVER a fresh final test.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import json
from pathlib import Path
import sys

import numpy as np

from noise_kws_v4_model import load_model
from train_noise_augmented_kws import LABELS
from train_noise_kws_v3 import DEFAULT_DATA
from train_noise_kws_v41 import V41_NAME

REPORT_NAME = "noise_temporal_context_v41.independent-evaluation.json"
AUDIT_NAME = "noise_temporal_context_v41.failure-audit.json"
GATE_THRESHOLD = 0.80
GATE_MARGIN = 0.15
KEYS = frozenset(LABELS)
GATE_REASONS = frozenset((
    "top_class_unknown", "below_fixed_threshold",
    "below_fixed_margin", "accepted",
))


def validated_frozen_report(report: dict, metadata: dict) -> list[dict]:
    if (metadata.get("model_variant") != "v41_context_preserving"
            or metadata.get("context_seconds_per_side") != 0.55
            or metadata.get("accept_threshold") != GATE_THRESHOLD
            or metadata.get("accept_margin") != GATE_MARGIN
            or metadata.get("research_only") is not True
            or metadata.get("alerts_authorized") is not False):
        raise ValueError("Invalid frozen V4.1 candidate or altered gate parameters")
    if (report.get("model_version") != metadata.get("version")
            or report.get("model_created_utc") != metadata.get("created_utc")
            or report.get("retraining_performed") is not False
            or report.get("operational_alerts_modified") is not False):
        raise ValueError("Saved evaluation does not match frozen V4.1 candidate metadata")
    entries = report.get("validation_per_file")
    if not isinstance(entries, list) or not entries:
        raise ValueError("Saved report is missing original per-file predictions")
    counts = Counter()
    for item in entries:
        if not isinstance(item, dict):
            raise ValueError("Invalid per-file item")
        expected, top, accepted = (item.get("expected"), item.get("raw_top_class"),
                                   item.get("accepted_class"))
        if expected not in KEYS or top not in KEYS or accepted not in KEYS:
            raise ValueError("Unknown class in saved evaluation")
        reason = item.get("decision_reason")
        if reason not in GATE_REASONS:
            raise ValueError("Unknown fixed-gate decision reason")
        try:
            p, margin = float(item["top_probability"]), float(item["top_margin"])
        except (ValueError, TypeError, KeyError) as exc:
            raise ValueError("Missing score or margin") from exc
        if not np.isfinite([p, margin]).all() or not 0 <= p <= 1 or not 0 <= margin <= 1:
            raise ValueError("Invalid scores in frozen evaluation")
        if (reason == "top_class_unknown") != (top == "unknown"):
            raise ValueError("Inconsistent UNKNOWN decision")
        if reason == "accepted" and (
            top == "unknown" or p < GATE_THRESHOLD - 1e-6
            or margin < GATE_MARGIN - 1e-6 or accepted != top
        ):
            raise ValueError("Saved acceptance violates original gate")
        if reason != "accepted" and accepted != "unknown":
            raise ValueError("Unexpected acceptance of a rejected hypothesis")
        if reason == "below_fixed_threshold" and (
            top == "unknown" or p >= GATE_THRESHOLD + 1e-6
        ):
            raise ValueError("Threshold-rejection metadata inconsistent")
        if reason == "below_fixed_margin" and (
            top == "unknown" or p < GATE_THRESHOLD - 1e-6
            or margin >= GATE_MARGIN + 1e-6
        ):
            raise ValueError("Margin-rejection metadata inconsistent")
        if item.get("correct_raw") != (top == expected) or (
            item.get("correct_accepted") != (accepted == expected)
        ):
            raise ValueError("Saved per-file correctness is inconsistent")
        counts[expected] += 1
    if any(counts[label] == 0 for label in LABELS):
        raise ValueError("Expected at least one original recording for all eight labels")
    if sum(counts[l] for l in LABELS if l != "unknown") != report.get("positive_wavs"):
        raise ValueError("Positive WAV count differs from per-file entries")
    if counts["unknown"] != report.get("unknown_wavs"):
        raise ValueError("UNKNOWN WAV count differs from per-file entries")
    return entries


def audit_v41(report: dict, metadata: dict) -> dict:
    entries = validated_frozen_report(report, metadata)
    positives = [r for r in entries if r["expected"] != "unknown"]
    negatives = [r for r in entries if r["expected"] == "unknown"]
    raw_correct = [r for r in positives if r["raw_top_class"] == r["expected"]]
    accepted_correct = [r for r in raw_correct if r["accepted_class"] == r["expected"]]
    correct_rejected = [r for r in raw_correct if r["accepted_class"] == "unknown"]
    classifier_wrong = [r for r in positives if r["raw_top_class"] != r["expected"]]
    wrong_accepted = [r for r in classifier_wrong if r["accepted_class"] != "unknown"]
    false_alarm = [r for r in negatives if r["accepted_class"] != "unknown"]
    if (len(raw_correct) != round(float(report["raw_top_positive_accuracy"]) * len(positives))
            or len(accepted_correct) != round(
                float(report["fixed_gate_positive_recall"]) * len(positives))
            or len(false_alarm) != report["unknown_false_positive_count"]):
        raise ValueError("Aggregate validation metrics disagree with per-file results")
    per_label = {}
    for label in LABELS:
        items = [r for r in entries if r["expected"] == label]
        group_correct = [r for r in items if r["raw_top_class"] == label]
        per_label[label] = {
            "count": len(items),
            "correct_raw": len(group_correct),
            "correctly_accepted": sum(r["accepted_class"] == label for r in items),
            "correctly_ranked_but_gate_rejected": sum(
                r["accepted_class"] == "unknown" for r in group_correct
                if label != "unknown"
            ),
            "raw_top_unknown": sum(r["raw_top_class"] == "unknown" for r in items),
            "raw_class_distribution": dict(Counter(r["raw_top_class"] for r in items)),
            "decision_reasons": dict(Counter(r["decision_reason"] for r in items)),
        }
    return {
        "status": "v41_frozen_failure_audit",
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "model_created_utc": metadata["created_utc"],
        "model_version": metadata["version"],
        "fixed_gate": {"threshold": GATE_THRESHOLD, "margin": GATE_MARGIN},
        "positive_wavs": len(positives),
        "unknown_wavs": len(negatives),
        "raw_correct_positive": len(raw_correct),
        "correctly_accepted_positive": len(accepted_correct),
        "correct_raw_but_rejected": len(correct_rejected),
        "wrong_raw_classification": len(classifier_wrong),
        "wrongly_accepted_keyword": len(wrong_accepted),
        "unknown_false_positive_count": len(false_alarm),
        "correct_ranked_rejections_by_reason": dict(
            Counter(r["decision_reason"] for r in correct_rejected)
        ),
        "wrong_raw_class_by_reason": dict(
            Counter(r["decision_reason"] for r in classifier_wrong)
        ),
        "per_label": per_label,
        "training_performed": False,
        "thresholds_changed": False,
        "original_recordings_replayed": False,
        "live_system_changed": False,
        "reviewed_dataset_reused": True,
        "methodological_warning": (
            "Descriptive failure analysis of an already reused and observed "
            "55-WAV research set. Do NOT change the safety gate to maximize "
            "these results or cite this as a fresh speaker-independent test. "
            "Neither file labels nor speaker identities can be verified from "
            "the saved report. Evaluate a frozen candidate on a NEW sealed "
            "consenting multi-speaker set and continuous negative audio."
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Frozen V4.1 failure audit; no model inference or training"
    )
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA)
    parser.add_argument("--candidate", type=Path)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    root = args.data.resolve()
    candidate = (args.candidate or root / "artifacts" / V41_NAME).resolve()
    report_path = (args.report or root / "artifacts" / REPORT_NAME).resolve()
    try:
        _, metadata = load_model(candidate)
        report = json.loads(report_path.read_text(encoding="utf-8"))
        analysis = audit_v41(report, metadata)
        print(json.dumps(analysis, indent=2))
        if not args.check:
            destination = root / "artifacts" / AUDIT_NAME
            with destination.open("x", encoding="utf-8") as f:
                json.dump(analysis, f, indent=2)
            print(f"[V4.1 frozen audit] Wrote read-only model diagnostics: {destination}")
        return 0
    except (OSError, ValueError, KeyError, TypeError, RuntimeError) as exc:
        print(f"[V4.1 frozen audit] Aborted: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
