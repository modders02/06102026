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
