"""V4 OFFLINE RESEARCH ONLY: speech candidate + learnable temporal CNN.

No live KWS, operational alerts, Camera Alerts, Event History, DTW enrollment
templates, stable branch, remote training services or legacy holdout access.

The 134 labeled train WAVs are split by authentic session annotations; any
validation is SAME-SPEAKER and used for checkpoint selection, NOT final test.
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

from noise_kws_v3_groups import (
    load_group_manifest, split_grouped,
)
from noise_kws_v4_audio import localize_speech_candidate, temporal_logmel
from noise_kws_v4_model import (
    MODEL_VERSION, fit_temporal_cnn, load_model,
    predict_fixed_gate, predict_proba, save_model,
)
from train_noise_augmented_kws import (
    LABELS, SAMPLE_RATE, augment_audio, noise_window, read_audio, wavs,
)
from train_noise_kws_v3 import DEFAULT_DATA, get_feature_engine

V4_NAME = "noise_temporal_cnn_v4.npz"


def feature_for_audio(samples: np.ndarray, extractor) -> tuple[np.ndarray, dict]:
    crop, status = localize_speech_candidate(samples)
    feature = temporal_logmel(crop, extractor)
    if feature.shape != (48, 32) or not np.isfinite(feature).all():
        raise ValueError("Invalid temporal feature sequence")
    return feature, status


def read_source(root: Path, item: dict, extractor) -> tuple[np.ndarray, dict]:
    source = root / item["relative_path"]
    audio = read_audio(source, extractor)
    return feature_for_audio(audio, extractor)


def inspect_all(root: Path, rows: list[dict], extractor) -> dict:
    failures = []
    details = []
    for item in rows:
        try:
            _, segment = read_source(root, item, extractor)
            details.append({
                "label": item["label"],
                "selected_duration_s": segment["duration_s"],
                "selection_reason": segment["reason"],
            })
        except (ValueError, OSError, RuntimeError) as exc:
            failures.append({
                "file": item["relative_path"],
                "reason": str(exc),
            })
    return {
        "passed": not failures,
        "scanned": len(rows),
        "issues": failures,
        "speech_labels_automatically_verified": False,
        "localization_selection_counts": dict(
            Counter(x["selection_reason"] for x in details)
        ),
        "per_label_median_selected_seconds": {
            label: round(float(np.median([
                row["selected_duration_s"] for row in details
                if row["label"] == label
            ])), 4)
            for label in LABELS
            if any(row["label"] == label for row in details)
        },
    }


def train_matrices(root: Path, training: list[dict], validation: list[dict],
                   extractor, variants: int, seed: int):
    if not 0 <= variants <= 12:
        raise ValueError("variants must be 0..12")
    rng = np.random.default_rng(seed)
    noises = wavs(root / "noise")
    if len(noises) < 3:
        raise ValueError("Need at least 3 original noise WAVs in noise/")
    noise_pool = [read_audio(path, extractor, background=True) for path in noises]

    tx, ty, vx, vy = [], [], [], []
    meta = {"train_files": [], "validation_files": [], "training_variants": variants,
            "synthetic_unknown_from_noise": len(noise_pool) * 3}
    for split, items, features, labels in (
        ("train", training, tx, ty),
        ("validation", validation, vx, vy),
    ):
        for item in items:
            samples = read_audio(root / item["relative_path"], extractor)
            try:
                feat, _ = feature_for_audio(samples, extractor)
            except (ValueError, RuntimeError) as exc:
                raise ValueError(f"{item['relative_path']}: {exc}") from exc
            features.append(feat)
            labels.append(LABELS.index(item["label"]))
            meta[split + "_files"].append(item["relative_path"])
            if split == "train":
                for n in range(variants):
                    try:
                        aug = augment_audio(samples, noise_pool, rng)
                        feat, _ = feature_for_audio(aug, extractor)
                    except (ValueError, RuntimeError) as exc:
                        raise ValueError(
                            f"Augment failure: {item['relative_path']} #{n+1}: {exc}"
                        ) from exc
                    tx.append(feat)
                    ty.append(LABELS.index(item["label"]))

    # Synthetic noise-only negatives can never join validation.
    for audio in noise_pool:
        for _ in range(3):
            clip = noise_window(audio, SAMPLE_RATE, rng)
            feat, _ = feature_for_audio(clip, extractor)
            tx.append(feat)
            ty.append(LABELS.index("unknown"))
    return (
        np.stack(tx).astype(np.float32), np.asarray(ty, np.int64),
        np.stack(vx).astype(np.float32), np.asarray(vy, np.int64),
        {
            "original_train_wavs": len(training),
            "original_session_validation_wavs": len(validation),
            "training_feature_sequences": len(tx),
            "validation_feature_sequences": len(vx),
            "augmentation_variants_per_train_original": variants,
            "synthetic_noise_negatives_train_only": len(noise_pool) * 3,
            "validation_augmentations": 0,
            "validation_relative_path_sha256": hashlib.sha256(
                "\n".join(sorted(meta["validation_files"])).encode("utf-8")
            ).hexdigest(),
            "original_train_relative_path_sha256": hashlib.sha256(
                "\n".join(sorted(meta["train_files"])).encode("utf-8")
            ).hexdigest(),
        }
    )


def score_validation(x: np.ndarray, y: np.ndarray, w: dict,
                     originals: list[dict]) -> dict:
    probs = predict_proba(x, w)
    top_ids = np.argmax(probs, axis=1)
    gate = np.array([predict_fixed_gate(p) for p in probs], np.int64)
    counts = Counter()
    confusion = {label: dict.fromkeys(LABELS, 0) for label in LABELS}
    reasons = Counter()
    entries = []
    for i, (item, true, top, accepted) in enumerate(
        zip(originals, y, top_ids, gate)
    ):
        true, top, accepted = int(true), int(top), int(accepted)
        order = np.argsort(-probs[i], kind="stable")
        margin = float(probs[i, order[0]] - probs[i, order[1]])
        if top == LABELS.index("unknown"):
            reason = "top_class_unknown"
        elif probs[i, top] < 0.80:
            reason = "below_fixed_threshold"
        elif margin < 0.15:
            reason = "below_fixed_margin"
        else:
            reason = "accepted"
        reasons[reason] += 1
        confusion[LABELS[true]][LABELS[accepted]] += 1
        counts[(LABELS[true], "total")] += 1
        if top == true:
            counts[(LABELS[true], "raw_correct")] += 1
        if accepted == true:
            counts[(LABELS[true], "gated_correct")] += 1
        entries.append({
            "file": item["relative_path"],
            "expected": LABELS[true],
            "raw_top_class": LABELS[top],
            "accepted_class": LABELS[accepted],
            "correct_raw": top == true,
            "correct_accepted": accepted == true,
            "top_probability": round(float(probs[i, top]), 6),
            "true_label_probability": round(float(probs[i, true]), 6),
            "top_margin": round(margin, 6),
            "decision_reason": reason,
        })
    positive = [r for r in entries if r["expected"] != "unknown"]
    negatives = [r for r in entries if r["expected"] == "unknown"]
    return {
        "positive_wavs": len(positive),
        "unknown_wavs": len(negatives),
        "raw_top_positive_accuracy": round(
            sum(r["correct_raw"] for r in positive) / max(1, len(positive)), 4),
        "fixed_gate_positive_recall": round(
            sum(r["correct_accepted"] for r in positive) / max(1, len(positive)), 4),
        "unknown_false_positive_count": sum(
            r["accepted_class"] != "unknown" for r in negatives),
        "unknown_false_positive_fraction": round(
            sum(r["accepted_class"] != "unknown" for r in negatives)
            / max(1, len(negatives)), 4),
        "decision_reasons": dict(reasons),
        "per_label": {
            label: {
                "count": counts[(label, "total")],
                "raw_correct": counts[(label, "raw_correct")],
                "accepted_correct": counts[(label, "gated_correct")],
            } for label in LABELS
        },
        "confusion_after_fixed_gate": confusion,
        "validation_per_file": entries,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Offline only: V4 temporal CNN research, never operational KWS"
    )
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--group-by", choices=("speaker", "session"),
                        default="session")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--epochs", type=int, default=65)
    parser.add_argument("--patience", type=int, default=10)
    parser.add_argument("--variants", type=int, default=3)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--overwrite", action="store_true",
                        help="Explicitly permit overwriting the V4 research artifact")
    args = parser.parse_args()
    if not 0 <= args.variants <= 12:
        parser.error("variants must be between 0 and 12")
    root = args.data.resolve()
    manifest = (args.manifest or (root / "group_manifest_v3.csv")).resolve()
    candidate = root / "artifacts" / V4_NAME

    try:
        rows = load_group_manifest(root, manifest)
        training, validation, split = split_grouped(
            rows, group_by=args.group_by, seed=args.seed
        )
        # The speaker overlap warning must be preserved, never suppressed.
        engine = get_feature_engine(root)
        audit = inspect_all(root, rows, engine)
        if not audit["passed"]:
            print(json.dumps({"status": "audio_rejected", "audit": audit}, indent=2))
            return 2
        if len(wavs(root / "noise")) < 3:
            raise ValueError("At least 3 original background noise WAVs required")
        print(json.dumps({
            "status": "v4_offline_ready", "group_split": split,
            "audio_audit": audit, "legacy_holdout_used": False,
            "external_alerts_changed": False,
        }, indent=2), flush=True)
        if args.check:
            return 0
        if candidate.exists() and not args.overwrite:
            raise ValueError(
                f"{candidate} exists. Back it up and pass --overwrite "
                "only when intentionally starting a new V4 experiment"
            )
        tx, ty, vx, vy, corpus = train_matrices(
            root, training, validation, engine, args.variants, args.seed
        )
        print(
            f"[Noise V4] training={len(tx)} sequence examples; "
            f"validation={len(vx)} untouched original WAVs", flush=True,
        )
        w, fit = fit_temporal_cnn(
            tx, ty, vx, vy, epochs=args.epochs,
            patience=args.patience, seed=args.seed
        )
        evaluation = score_validation(vx, vy, w, validation)
        metadata = {
            "version": MODEL_VERSION,
            "created_utc": datetime.now(timezone.utc).isoformat(),
            "labels": list(LABELS),
            "model_kind": "NumPy 5-frame temporal CNN, 1/2/4 pyramid pooling",
            "audio_localization": "label-blind acoustic contrast, capped 1.6 s",
            "seed": args.seed, "group_by": args.group_by,
            "validation_checkpoint_selected": True,
            "accept_threshold": 0.80, "accept_margin": 0.15,
            "research_only": True, "alerts_authorized": False,
        }
        save_model(candidate, w, metadata)
        report = {
            "model_metadata": metadata,
            "candidate": str(candidate),
            "group_split": split,
            "audio_audit": audit,
            "dataset": corpus,
            "training": fit,
            "session_validation": evaluation,
            "legacy_holdout_used": False,
            "active_dtw_templates_modified": False,
            "live_detection_modified": False,
            "operational_alerts_modified": False,
            "warning": (
                "V4 is RESEARCH ONLY. This one-speaker session validation was "
                "used for early stopping and to design V4; it is NOT an unbiased "
                "independent test. Energy contrast does not verify speech content. "
                "Never use the V4 NPZ with the existing V1/V3 shadow loaders or "
                "operational emergency alert system."
            ),
        }
        report_path = candidate.with_suffix(".report.json")
        report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(json.dumps({
            "saved_candidate": str(candidate),
            "saved_report": str(report_path),
            "best_epoch": fit["best_epoch"],
            "epochs_ran": fit["epochs_ran"],
            "validation": {
                k: v for k, v in evaluation.items()
                if k not in ("validation_per_file", "confusion_after_fixed_gate")
            },
            "live_system_unchanged": True,
        }, indent=2))
        return 0
    except (OSError, KeyError, ValueError, RuntimeError) as exc:
        print(f"[Noise V4] Aborted: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
