"""Evaluate a FROZEN V4.1 context-preserving research model on freshly recorded independent local WAVs.

This tool neither trains nor selects a checkpoint, and never reads the old
holdout or modifies operational MSDS. Test-root must be a separate private
capture directory, containing train/<label>/*.wav for all eight classes.
External speaker/session independence must be verified by the researcher.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys

import numpy as np

from noise_kws_v3_groups import load_group_manifest
from noise_kws_v4_model import load_model
from train_noise_augmented_kws import LABELS, read_audio, wavs
from train_noise_kws_v3 import DEFAULT_DATA, get_feature_engine
from train_noise_kws_v41 import V41_NAME, feature_for_audio, score_validation


def resolve_test_root(root: Path, candidate: Path) -> Path:
    root, candidate = root.resolve(), candidate.resolve()
    if candidate == root:
        raise ValueError("Independent test directory cannot be the training dataset root")
    try:
        rel = candidate.relative_to(root)
    except ValueError:
        return candidate
    blocked = {"train", "holdout", "staging", "capture-pilot", "quarantine", "noise", "artifacts"}
    if not rel.parts or rel.parts[0].lower() in blocked:
        raise ValueError("Independent test directory conflicts with training/legacy/staging data")
    return candidate


def evaluate_fresh(root: Path, manifest: Path,
                   model_path: Path, test_root: Path) -> dict:
    test_root = resolve_test_root(root, test_root)
    w, metadata = load_model(model_path)
    # The training manifest verifies original train WAVs and catches duplicate
    # files; never inspect legacy holdout during independent evaluation.
    old = load_group_manifest(root, manifest)
    train_digests = {item["sha256"] for item in old}
    rows, x, y = [], [], []
    extractor = get_feature_engine(root)
    for label in LABELS:
        folder = test_root / "train" / label
        files = wavs(folder)
        if not files:
            raise ValueError(f"Missing independent test WAVs: {folder}")
        for file in files:
            digest = hashlib.sha256(file.read_bytes()).hexdigest()
            if digest in train_digests:
                raise ValueError(f"Independent file duplicates a training WAV: {file.name}")
            audio = read_audio(file, extractor)
            feat, _ = feature_for_audio(audio, extractor)
            rows.append({
                "relative_path": f"train/{label}/{file.name}",
                "label": label,
            })
            x.append(feat)
            y.append(LABELS.index(label))
    report = score_validation(
        np.stack(x).astype(np.float32),
        np.asarray(y, dtype=np.int64),
        w, rows,
    )
    report.update({
        "model_version": metadata["version"],
        "model_created_utc": metadata.get("created_utc"),
        "test_directory": str(test_root),
        "test_original_recordings": len(rows),
        "retraining_performed": False,
        "checkpoint_reselected": False,
        "legacy_holdout_used": False,
        "live_detection_modified": False,
        "operational_alerts_modified": False,
        "warning": (
            "V4.1 context selection was influenced by earlier validation. "
            "Independent evaluation is credible ONLY if these recordings "
            "were made after the V4.1 architecture/checkpoint was frozen and "
            "their speaker/session provenance is genuinely independent. "
            "Programmatic hash checks prevent exact training duplicates, "
            "but cannot prove new people, rooms, or sessions. "
            "Do not tune V4.1 on the results and claim an unbiased final test."
        ),
    })
    return report


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Evaluate frozen V4.1 offline on new manually verified recordings"
    )
    parser.add_argument("--test-data", type=Path, required=True,
                        help="Separate fresh WAV root containing train/<word>/*.wav")
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA)
    parser.add_argument("--candidate", type=Path)
    parser.add_argument("--manifest", type=Path)
    args = parser.parse_args()
    root = args.data.resolve()
    candidate = (args.candidate or (root / "artifacts" / V41_NAME)).resolve()
    manifest = (args.manifest or (root / "group_manifest_v3.csv")).resolve()
    try:
        report = evaluate_fresh(
            root, manifest, candidate, args.test_data.resolve()
        )
        out = candidate.with_suffix(".independent-evaluation.json")
        out.write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(json.dumps({
            "source": report["test_directory"],
            "positive_wavs": report["positive_wavs"],
            "unknown_wavs": report["unknown_wavs"],
            "raw_top_positive_accuracy": report["raw_top_positive_accuracy"],
            "fixed_gate_positive_recall": report["fixed_gate_positive_recall"],
            "unknown_false_positive_count": report["unknown_false_positive_count"],
            "unknown_false_positive_fraction": report["unknown_false_positive_fraction"],
            "per_label": report["per_label"],
            "saved_report": str(out),
            "warning": report["warning"],
        }, indent=2))
        return 0
    except (OSError, KeyError, ValueError, RuntimeError) as exc:
        print(f"[Noise V4.1 independent evaluation] Aborted: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
