"""Frozen V3 MLP offline evaluation on separately captured, manually labelled WAVs.

This is a REFINE-BEFORE-RETRAIN diagnostic; no retraining, no threshold changes,
no live CCTV, no DTW enrollment, no alerts or Event History writes.
The available 55-WAV dataset is already observed under V4.1/V5 and must be
considered exploratory; operator validates labels/speaker provenance.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys

import numpy as np

from noise_kws_v3_groups import load_group_manifest, split_grouped
from prepare_neural_kws import KEYWORDS
from train_noise_augmented_kws import (
    ACCEPT_THRESHOLD, ACCEPT_MARGIN, LABELS, feature_vector,
    infer_probs, read_audio, wavs,
)
from train_noise_kws_v3 import DEFAULT_DATA, get_feature_engine, load_v3

DEFAULT_MODEL = "noise_augmented_shadow_v3.npz"
REPORT_NAME = "noise_augmented_shadow_v3.frozen-new-recordings.json"


def verify_frozen_v3(root: Path, manifest: Path, candidate: Path) -> tuple[dict, dict]:
    """Ensure the checkpoint belongs to the unchanged, known V3 split.

    The original training report is required to rule out using an unrelated
    checkpoint with a familiar filename. No holdout/validation WAV is decoded.
    """
    weights, metadata = load_v3(candidate)
    if not metadata.get("shadow_only") or metadata.get("live_alerts_authorized") is not False:
        raise ValueError("V3 checkpoint has insufficient research-only safety metadata")
    if (metadata.get("accept_threshold") != ACCEPT_THRESHOLD or
            metadata.get("accept_margin") != ACCEPT_MARGIN):
        raise ValueError("V3 checkpoint thresholds differ from the frozen baseline")
    report_path = candidate.with_suffix(".report.json")
    if not report_path.is_file():
        raise ValueError(f"Missing original V3 training report: {report_path}")
    report = json.loads(report_path.read_text(encoding="utf-8"))
    if report.get("model_metadata") != metadata:
        raise ValueError("Saved V3 report metadata differs from model checkpoint")
    rows = load_group_manifest(root, manifest)
    expected_train = report.get("dataset", {}).get("train_original_files")
    if metadata.get("group_by") not in ("speaker", "session"):
        raise ValueError("Unknown original grouped split mode")
    train, validation, split = split_grouped(
        rows, group_by=metadata["group_by"], seed=int(metadata["seed"])
    )
    validation_hash = hashlib.sha256(
        "\n".join(sorted(r["relative_path"] for r in validation)).encode()
    ).hexdigest()
    if (len(train) != expected_train or
            report.get("dataset", {}).get("validation_file_manifest_sha256") != validation_hash):
        raise ValueError("Original V3 train/validation membership no longer matches checkpoint")
    return weights, {
        "model_metadata": metadata,
        "speaker_disjoint_on_original_validation": split["speaker_disjoint"],
        "original_validation_is_final_test": False,
        "original_train_source_wavs": len(train),
        "original_development_validation_wavs": len(validation),
        "training_sha256": {r["sha256"] for r in rows},
    }


def enumerate_evaluation_wavs(root: Path, test_root: Path, original_hashes: set) -> tuple[list, str]:
    root, test_root = root.resolve(), test_root.resolve()
    if test_root == root:
        raise ValueError("Test dataset cannot equal original V3 training root")
    try:
        rel = test_root.relative_to(root)
    except ValueError:
        rel = None
    if rel is not None and (not rel.parts or rel.parts[0].lower() in {
        "train", "holdout", "noise", "staging", "capture-pilot",
        "quarantine", "artifacts", "_feature-only-no-enrollments",
    }):
        raise ValueError("Test dataset cannot use original training, validation or holdout folders")
    files, encountered = [], set()
    for label in LABELS:
        folder = test_root / "train" / label
        if not folder.is_dir() or folder.is_symlink():
            raise ValueError(f"Missing or unsafe test label folder: {folder}")
        recordings = wavs(folder)
        if not recordings:
            raise ValueError(f"Missing evaluation recordings: {folder}")
        for file in recordings:
            digest = hashlib.sha256(file.read_bytes()).hexdigest()
            if digest in original_hashes:
                raise ValueError(f"Test recording duplicates V3 development data: {file.name}")
            if digest in encountered:
                raise ValueError(f"Repeated WAV bytes in evaluation set: {file.name}")
            encountered.add(digest)
            files.append((label, file, digest))
    fingerprint = hashlib.sha256(
        "\n".join(f"{label}/{file.name}:{digest}"
                  for label, file, digest in files).encode("utf-8")
    ).hexdigest()
    return files, fingerprint


def gated_prediction(probabilities: np.ndarray) -> dict:
    """Use V3's original, unmodified confidence and margin gate."""
    arr = np.asarray(probabilities, dtype=np.float64)
    if arr.shape != (len(LABELS),) or not np.isfinite(arr).all():
        raise ValueError("Invalid frozen V3 probability array")
    order = np.argsort(-arr, kind="stable")
    best, runner = int(order[0]), int(order[1])
    top = LABELS[best]
    p = float(arr[best])
    margin = p - float(arr[runner])
    if top == "unknown":
        reason = "top_class_unknown"
        accepted = "unknown"
    elif p < ACCEPT_THRESHOLD:
        reason = "below_fixed_threshold"
        accepted = "unknown"
    elif margin < ACCEPT_MARGIN:
        reason = "below_fixed_margin"
        accepted = "unknown"
    else:
        reason = "accepted"
        accepted = top
    return {
        "raw_top_class": top,
        "gated_prediction": accepted,
        "gate_reason": reason,
        "top_probability": round(p, 6),
        "top_margin": round(margin, 6),
        "top_three": [
            {"label": LABELS[int(i)], "probability": round(float(arr[int(i)]), 6)}
            for i in order[:3]
        ],
    }


def summarize(rows: list[dict]) -> dict:
    if any(not any(r["expected"] == label for r in rows) for label in LABELS):
        raise ValueError("Every class must have at least one test WAV")
    positives = [r for r in rows if r["expected"] != "unknown"]
    negative = [r for r in rows if r["expected"] == "unknown"]
    accepted_correct = sum(r["gated_prediction"] == r["expected"] for r in positives)
    raw_correct = sum(r["raw_top_class"] == r["expected"] for r in positives)
    false_positives = sum(r["gated_prediction"] != "unknown" for r in negative)
    by_class = {}
    for label in LABELS:
        matching = [r for r in rows if r["expected"] == label]
        by_class[label] = {
            "count": len(matching),
            "raw_correct": sum(r["raw_top_class"] == label for r in matching),
            "accepted_correct": sum(r["gated_prediction"] == label for r in matching),
            "gate_reasons": dict(Counter(r["gate_reason"] for r in matching)),
            "raw_top_classes": dict(Counter(r["raw_top_class"] for r in matching)),
        }
    return {
        "positive_wavs": len(positives),
        "unknown_wavs": len(negative),
        "raw_top_positive_accuracy": round(raw_correct / len(positives), 4),
        "fixed_gate_positive_recall": round(accepted_correct / len(positives), 4),
        "correctly_accepted_positive_count": accepted_correct,
        "unknown_false_positive_count": false_positives,
        "unknown_false_positive_fraction": round(false_positives / len(negative), 4),
        "gate_reasons": dict(Counter(r["gate_reason"] for r in rows)),
        "per_label": by_class,
    }


def evaluate_frozen_v3(root: Path, manifest: Path, candidate: Path,
                       test_root: Path, *, decode: bool = True) -> dict:
    weights, info = verify_frozen_v3(root, manifest, candidate)
    files, fingerprint = enumerate_evaluation_wavs(
        root, test_root, info["training_sha256"]
    )
    info.pop("training_sha256")
    summary = {
        "status": "v3_frozen_exploratory_data_checked",
        "candidate": str(candidate.resolve()),
        "test_directory": str(test_root.resolve()),
        "test_fingerprint_sha256": fingerprint,
        "test_recording_count": len(files),
        "model": info,
        "retraining_performed": False,
        "thresholds_tuned": False,
        "operational_alerts_changed": False,
        "legacy_holdout_used": False,
        "speaker_independence": "requires_operator_verification",
        "label_quality": "requires_operator_verification",
        "warning": (
            "The 55-WAV cohort was already observed with V4.1 and V5. "
            "This V3 evaluation is an EXPLORATORY matched-set comparison, "
            "NOT new final-test evidence. Do not tune thresholds or train "
            "on this cohort and call it unbiased. Exact WAV SHA checks do "
            "not prove speaker/session independence or label correctness."
        ),
    }
    if not decode:
        return summary
    extractor = get_feature_engine(root)
    observations = []
    for index, (label, file, digest) in enumerate(files, 1):
        samples = read_audio(file, extractor)
        features = feature_vector(samples, extractor)
        probs = infer_probs(features[None, :], weights)[0]
        row = {
            "expected": label,
            "file": f"train/{label}/{file.name}",
            "sha256": digest,
            **gated_prediction(probs),
        }
        row["raw_correct"] = row["raw_top_class"] == label
        row["accepted_correct"] = (row["gated_prediction"] == label)
        observations.append(row)
        print(
            f"[V3 frozen] {index}/{len(files)} {label.upper()} "
            f"raw={row['raw_top_class']} gated={row['gated_prediction']} "
            f"reason={row['gate_reason']}", flush=True
        )
    summary.update(summarize(observations))
    summary.update({
        "status": "v3_frozen_exploratory_evaluation_complete",
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "per_file": observations,
    })
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Evaluate original V3 MLP frozen on separate WAVs without training."
    )
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--candidate", type=Path)
    parser.add_argument("--test-data", type=Path, required=True)
    parser.add_argument("--check", action="store_true",
                        help="Check V3 checkpoint and data fingerprint without audio decoding")
    args = parser.parse_args()
    root = args.data.resolve()
    manifest = (args.manifest or root / "group_manifest_v3.csv").resolve()
    candidate = (args.candidate or root / "artifacts" / DEFAULT_MODEL).resolve()
    test_root = args.test_data.resolve()
    try:
        result = evaluate_frozen_v3(
            root, manifest, candidate, test_root, decode=not args.check
        )
        if args.check:
            print(json.dumps(result, indent=2))
            return 0
        target = root / "artifacts" / REPORT_NAME
        if target.exists():
            raise ValueError(
                f"Frozen V3 result already exists; refusing overwrite: {target}"
            )
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("x", encoding="utf-8") as out:
            json.dump(result, out, indent=2)
        compact_keys = [
            "status", "positive_wavs", "unknown_wavs",
            "raw_top_positive_accuracy", "fixed_gate_positive_recall",
            "correctly_accepted_positive_count", "unknown_false_positive_count",
            "per_label", "test_fingerprint_sha256", "warning",
        ]
        print(json.dumps({
            **{key: result[key] for key in compact_keys},
            "saved_report": str(target),
        }, indent=2))
        return 0
    except (OSError, ValueError, RuntimeError, KeyError) as exc:
        print(f"[V3 frozen] Cannot evaluate: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
