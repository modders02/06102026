"""Read-only diagnostics for saved V3 KWS research candidate.

This does NOT retrain, tune thresholds, load active enrollment templates,
read the legacy holdout, save audio, or affect emergency alert decisions.
The CSV training group split is checked against the saved V3 training report.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import statistics
import sys

import numpy as np

from noise_kws_v3_groups import load_group_manifest, split_grouped
from train_noise_augmented_kws import (
    ACCEPT_MARGIN, ACCEPT_THRESHOLD, LABELS, SAMPLE_RATE,
    feature_vector, infer_probs, read_audio,
)
from train_noise_kws_v3 import (
    DEFAULT_DATA, get_feature_engine, load_v3,
)


def decision_from_probabilities(probabilities: np.ndarray, expected: str) -> dict:
    """Separate raw ranking, confidence gating and incorrect word hypotheses."""
    scores = np.asarray(probabilities, dtype=np.float64)
    if (scores.shape != (len(LABELS),) or
            not np.isfinite(scores).all() or
            np.min(scores) < 0 or
            abs(float(np.sum(scores)) - 1.0) > 0.002):
        raise ValueError("Invalid class probability vector")
    if expected not in LABELS:
        raise ValueError(f"Unknown label: {expected}")
    order = np.argsort(-scores, kind="stable")
    top_index, runner_index = int(order[0]), int(order[1])
    raw_top = LABELS[top_index]
    p = float(scores[top_index])
    margin = p - float(scores[runner_index])
    if raw_top == "unknown":
        reason = "top_class_unknown"
        prediction = "unknown"
    elif p < ACCEPT_THRESHOLD:
        reason = "below_fixed_threshold"
        prediction = "unknown"
    elif margin < ACCEPT_MARGIN:
        reason = "below_fixed_margin"
        prediction = "unknown"
    else:
        reason = "accepted"
        prediction = raw_top
    return {
        "expected": expected,
        "raw_top_class": raw_top,
        "raw_top_matches_label": raw_top == expected,
        "predicted_after_safety_gate": prediction,
        "accepted_correctly": prediction == expected and expected != "unknown",
        "decision_reason": reason,
        "top_probability": round(p, 6),
        "top_margin": round(margin, 6),
        "expected_label_probability": round(
            float(scores[LABELS.index(expected)]), 6),
        "top_three": [
            {"label": LABELS[int(i)], "probability": round(float(scores[i]), 6)}
            for i in order[:3]
        ],
    }


def _median(values: list[float]) -> float | None:
    return round(float(statistics.median(values)), 5) if values else None


def summarize(items: list[dict], split_name: str) -> dict:
    known = [row for row in items if row["expected"] != "unknown"]
    negatives = [row for row in items if row["expected"] == "unknown"]
    reasons = Counter(row["decision_reason"] for row in items)
    by_label = {}
    for label in LABELS:
        group = [x for x in items if x["expected"] == label]
        by_label[label] = {
            "count": len(group),
            "raw_argmax_correct": sum(x["raw_top_matches_label"] for x in group),
            "after_gate_correct": sum(
                x["predicted_after_safety_gate"] == label for x in group
            ),
            "top_class_distribution": dict(
                Counter(x["raw_top_class"] for x in group)
            ),
            "decision_reasons": dict(Counter(x["decision_reason"] for x in group)),
            "median_rms": _median([x["rms"] for x in group]),
            "median_trimmed_duration_s": _median(
                [x["energy_trimmed_duration_s"] for x in group]
            ),
            "median_top_probability": _median(
                [x["top_probability"] for x in group]
            ),
        }
    raw_correct = sum(row["raw_top_matches_label"] for row in known)
    gated_correct = sum(row["accepted_correctly"] for row in known)
    negatives_wrongly_accepted = sum(
        x["predicted_after_safety_gate"] != "unknown" for x in negatives
    )
    return {
        "split": split_name,
        "source_wavs": len(items),
        "positive_source_wavs": len(known),
        "unknown_source_wavs": len(negatives),
        "raw_top_positive_accuracy": round(raw_correct / len(known), 4) if known else None,
        "fixed_gate_positive_recall": round(gated_correct / len(known), 4) if known else None,
        "unknown_false_positive_fraction": round(
            negatives_wrongly_accepted / len(negatives), 4
        ) if negatives else None,
        "unknown_false_positive_count": negatives_wrongly_accepted,
        "raw_top_class_distribution": dict(
            Counter(x["raw_top_class"] for x in items)
        ),
        "decision_reasons": dict(reasons),
        "median_rms": _median([x["rms"] for x in items]),
        "median_trimmed_duration_s": _median(
            [x["energy_trimmed_duration_s"] for x in items]
        ),
        "median_trimmed_fraction": _median(
            [x["trimmed_fraction"] for x in items]
        ),
        "per_label": by_label,
    }



def acoustic_signature(samples: np.ndarray, extracted: np.ndarray,
                       weights: dict) -> dict:
    """Amplitude and feature-distribution proxies; NOT speech transcription.

    300 ms windows show whether audio energy concentrates in speech-like
    intervals or fills the whole clip. Continuous sound could be speech,
    fan, room hum or camera artifacts: listen to the WAV before labeling.
    """
    samples = np.asarray(samples, dtype=np.float32)
    if not len(samples) or extracted.shape != weights["mean"].shape:
        raise ValueError("Invalid acoustic sample/feature shape")
    window = max(1, int(SAMPLE_RATE * 0.3))
    first = samples[:window]
    mid_start = max(0, (len(samples) - window) // 2)
    middle = samples[mid_start:mid_start + window]
    last = samples[-window:]
    def energy(values):
        return float(np.sqrt(np.mean(values * values, dtype=np.float64) + 1e-12))
    first_rms, middle_rms, last_rms = map(energy, (first, middle, last))
    windows = [
        energy(samples[pos:pos + window])
        for pos in range(0, len(samples), window)
    ]
    dynamic_db = 20 * np.log10((max(windows) + 1e-9) / (min(windows) + 1e-9))
    normalized = (extracted - weights["mean"]) / weights["scale"]
    return {
        "first_300ms_rms": round(first_rms, 6),
        "middle_300ms_rms": round(middle_rms, 6),
        "last_300ms_rms": round(last_rms, 6),
        "rms_dynamic_range_db": round(float(dynamic_db), 4),
        "near_clipped_fraction": round(float(np.mean(np.abs(samples) >= 0.98)), 6),
        "logmel_vector_mean": round(float(np.mean(extracted)), 5),
        "logmel_vector_std": round(float(np.std(extracted)), 5),
        "normalized_feature_distance": round(
            float(np.sqrt(np.mean(normalized * normalized))), 4
        ),
    }


def session_acoustic_comparison(training: list[dict],
                                validation: list[dict]) -> dict:
    """Only observational statistics, never thresholds or model selection."""
    keys = (
        "rms", "energy_trimmed_duration_s", "trimmed_fraction",
        "first_300ms_rms", "middle_300ms_rms", "last_300ms_rms",
        "rms_dynamic_range_db", "near_clipped_fraction",
        "logmel_vector_mean", "logmel_vector_std",
        "normalized_feature_distance",
    )
    def stats(items):
        return {name: _median([x[name] for x in items]) for name in keys}
    by_label = {}
    for label in LABELS:
        train_items = [x for x in training if x["expected"] == label]
        val_items = [x for x in validation if x["expected"] == label]
        by_label[label] = {
            "train": stats(train_items),
            "validation": stats(val_items),
        }
    train_summary = stats(training)
    val_summary = stats(validation)
    train_rms = train_summary["rms"]
    val_rms = val_summary["rms"]
    return {
        "train_medians": train_summary,
        "validation_medians": val_summary,
        "validation_to_training_median_rms_ratio": (
            round(val_rms / train_rms, 4)
            if train_rms is not None and val_rms is not None and train_rms > 0
            else None
        ),
        "per_label": by_label,
        "interpretation": (
            "These are acoustic proxies, not verified spoken labels or "
            "proof of cause. Inspect original WAV playback for missing or "
            "truncated words, constant noise and session differences. "
            "Do not tune fixed safety thresholds using this validation."
        ),
    }


def diagnose_original_files(root: Path, rows: list[dict], split_name: str,
                            engine, weights: dict) -> list[dict]:
    results = []
    for item in rows:
        source = root / item["relative_path"]
        samples = read_audio(source, engine)
        x = feature_vector(samples, engine)
        distribution = infer_probs(x.reshape(1, -1), weights)[0]
        result = decision_from_probabilities(distribution, item["label"])
        energy_trimmed = engine._trim_energy(samples)
        result.update({
            "file": item["relative_path"],
            "split": split_name,
            "duration_s": round(len(samples) / SAMPLE_RATE, 5),
            "energy_trimmed_duration_s": round(
                len(energy_trimmed) / SAMPLE_RATE, 5
            ),
            "trimmed_fraction": round(
                len(energy_trimmed) / max(1, len(samples)), 5
            ),
            "rms": round(float(np.sqrt(np.mean(samples * samples) + 1e-12)), 6),
            "peak": round(float(np.max(np.abs(samples))), 6),
        })
        result.update(acoustic_signature(samples, x, weights))
        results.append(result)
    return results


def diagnose(root: Path, manifest: Path, model: Path, *,
             seed: int | None = None) -> dict:
    weights, metadata = load_v3(model)
    report_file = model.with_suffix(".report.json")
    if not report_file.is_file():
        raise ValueError(f"V3 training report missing: {report_file}")
    with report_file.open("r", encoding="utf-8") as f:
        history = json.load(f)
    if metadata != history.get("model_metadata"):
        raise ValueError("V3 candidate metadata does not match saved training report")
    group_by = metadata.get("group_by")
    original_seed = int(metadata["seed"])
    if seed is not None and seed != original_seed:
        raise ValueError(
            "A different split seed would invalidate comparison to the saved model. "
            f"Use its original seed {original_seed}."
        )
    rows = load_group_manifest(root, manifest)
    train_rows, validation_rows, split_info = split_grouped(
        rows, group_by=group_by, seed=original_seed
    )
    val_hash = hashlib.sha256(
        "\n".join(sorted(r["relative_path"] for r in validation_rows)).encode("utf-8")
    ).hexdigest()
    expected_hash = history.get("dataset", {}).get("validation_file_manifest_sha256")
    if not expected_hash or val_hash != expected_hash:
        raise ValueError(
            "Validation WAV membership changed since V3 training. "
            "Do not treat this as the original session-separated result."
        )
    expected_train_size = history.get("dataset", {}).get("train_original_files")
    if expected_train_size != len(train_rows):
        raise ValueError("Training source membership/count changed since V3 training")
    engine = get_feature_engine(root)
    training_items = diagnose_original_files(
        root, train_rows, "training_originals", engine, weights
    )
    validation_items = diagnose_original_files(
        root, validation_rows, "session_validation", engine, weights
    )
    summary = {
        "training": summarize(training_items, "training_originals"),
        "validation": summarize(validation_items, "session_validation"),
    }
    acoustic = session_acoustic_comparison(training_items, validation_items)
    return {
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "candidate": str(model),
        "model_version": metadata["version"],
        "split": split_info,
        "thresholds_unchanged": {
            "accept_threshold": ACCEPT_THRESHOLD,
            "accept_margin": ACCEPT_MARGIN,
        },
        "summary": summary,
        "acoustic_session_comparison": acoustic,
        "validation_per_file": validation_items,
        "training_per_file": training_items,
        "validation_errors": [
            row for row in validation_items
            if row["predicted_after_safety_gate"] != row["expected"]
        ],
        "fire_validation": [
            row for row in validation_items if row["expected"] == "fire"
        ],
        "warning": (
            "Read-only research diagnostics on session-separated data used "
            "for early stopping. No threshold optimization or live alert "
            "change is authorized. Raw argmax is NOT an emergency detector "
            "and may be uncalibrated. Audio word labels remain unverified."
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Diagnose saved V3 confidence gating and session shift, read-only"
    )
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--candidate", type=Path)
    parser.add_argument("--show-files", action="store_true",
                        help="List the original validation WAV classifications")
    parser.add_argument("--seed", type=int, default=None)
    args = parser.parse_args()
    root = args.data.resolve()
    model = (args.candidate or
             (root / "artifacts" / "noise_augmented_shadow_v3.npz")).resolve()
    manifest = (args.manifest or
                (root / "group_manifest_v3.csv")).resolve()
    try:
        result = diagnose(root, manifest, model, seed=args.seed)
    except (OSError, ValueError, KeyError, RuntimeError) as err:
        print(f"[Noise V3 diagnose] Cannot analyze: {err}", file=sys.stderr)
        return 2
    # Privacy: the compact output contains no filename or speaker identifiers.
    summary = result["summary"]
    compact = {
        "candidate": str(model),
        "training": summary["training"],
        "validation": summary["validation"],
        "acoustic_session_comparison": {
            "train_medians": result["acoustic_session_comparison"]["train_medians"],
            "validation_medians": result["acoustic_session_comparison"]["validation_medians"],
            "validation_to_training_median_rms_ratio": result["acoustic_session_comparison"]["validation_to_training_median_rms_ratio"],
            "interpretation": result["acoustic_session_comparison"]["interpretation"],
        },
        "warning": result["warning"],
    }
    print(json.dumps(compact, indent=2))
    if args.show_files:
        for item in result["validation_per_file"]:
            tops = ", ".join(
                f"{p['label']}:{p['probability']:.3f}"
                for p in item["top_three"]
            )
            print(
                f"[{item['expected']}] {item['file']} "
                f"raw_top={item['raw_top_class']} "
                f"gated={item['predicted_after_safety_gate']} "
                f"p={item['top_probability']:.3f} "
                f"margin={item['top_margin']:.3f} "
                f"reason={item['decision_reason']} "
                f"speech_trim_s={item['energy_trimmed_duration_s']:.3f} "
                f"top3={tops}"
            )
    path = model.with_suffix(".diagnostic.json")
    path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(f"[Noise V3 diagnose] Saved metadata-only report: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
