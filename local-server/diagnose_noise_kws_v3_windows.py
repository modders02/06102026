"""Read-only V3 audio-window sensitivity audit on the SAME checkpoint-selected validation.

This is NOT a voice activity detector, model update, threshold optimization or
independent test. The candidate windows are selected by waveform RMS alone,
without using expected labels or neural probabilities. Results may reveal
whether V3's full-window feature representation is sensitive to the roughly
0.5-second training speech versus 2.5-second validation audio.

No training, active DTW enrollment, alerts, CCTV recording or legacy holdout.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

import numpy as np

from diagnose_noise_kws_v3 import diagnose, decision_from_probabilities
from noise_kws_v3_groups import load_group_manifest, split_grouped
from train_noise_augmented_kws import (
    LABELS, SAMPLE_RATE, feature_vector, infer_probs, read_audio,
)
from train_noise_kws_v3 import DEFAULT_DATA, get_feature_engine, load_v3

WINDOW_SECONDS = (0.8, 1.2, 1.6)
HOP_SECONDS = 0.05


def max_rms_window(samples: np.ndarray, length: int, hop: int) -> tuple[np.ndarray, int]:
    """Choose a fixed-length window using ONLY energy, not words or confidence.

    Uses a float64 prefix-sum to avoid O(n * window_length) scanning.
    Ties select the earliest candidate. This is an acoustic diagnostic only:
    loud fans/TV can win over speech.
    """
    values = np.asarray(samples, dtype=np.float32)
    if values.ndim != 1 or len(values) == 0 or not np.isfinite(values).all():
        raise ValueError("Expected nonempty finite mono PCM")
    if length <= 0 or hop <= 0:
        raise ValueError("Window length and hop must be positive")
    if length >= len(values):
        return values.copy(), 0

    last = len(values) - length
    starts = np.arange(0, last + 1, hop, dtype=np.int64)
    if starts[-1] != last:
        starts = np.append(starts, last)
    squares = values.astype(np.float64) ** 2
    cumulative = np.concatenate(([0.0], np.cumsum(squares)))
    energies = cumulative[starts + length] - cumulative[starts]
    start = int(starts[int(np.argmax(energies))])
    return values[start:start + length].copy(), start


def describe_prediction(decision: dict) -> dict:
    return {
        "raw_top_class": decision["raw_top_class"],
        "top_probability": decision["top_probability"],
        "top_margin": decision["top_margin"],
        "decision_reason": decision["decision_reason"],
        "accepted_class": decision["predicted_after_safety_gate"],
        "raw_correct": bool(decision["raw_top_matches_label"]),
        "accepted_correct": bool(
            decision["accepted_correctly"] if decision["expected"] != "unknown"
            else decision["predicted_after_safety_gate"] == "unknown"
        ),
    }


def summarize_predictions(items: list[dict], name: str) -> dict:
    positives = [i for i in items if i["expected"] != "unknown"]
    negatives = [i for i in items if i["expected"] == "unknown"]
    def metric(group, field):
        if not group:
            return None
        return round(sum(i[field] for i in group) / len(group), 4)
    return {
        "method": name,
        "evaluated_positive": len(positives),
        "evaluated_unknown": len(negatives),
        "raw_top_positive_accuracy": metric(positives, "raw_correct"),
        "fixed_gate_positive_recall": metric(positives, "accepted_correct"),
        "unknown_false_positive_count": sum(
            i["accepted_class"] != "unknown" for i in negatives
        ),
        "unknown_false_positive_fraction": (
            round(sum(i["accepted_class"] != "unknown" for i in negatives)
                  / len(negatives), 4) if negatives else None
        ),
        "by_label": {
            label: {
                "count": sum(i["expected"] == label for i in items),
                "raw_correct": sum(
                    i["expected"] == label and i["raw_correct"] for i in items
                ),
                "gated_correct": sum(
                    i["expected"] == label and i["accepted_correct"] for i in items
                ),
            }
            for label in LABELS
        },
    }


def run_audit(root: Path, manifest: Path, candidate: Path) -> dict:
    # Reuse the existing V3 strict report/manifest/split-fingerprint verification.
    original_report = diagnose(root, manifest, candidate)
    weights, meta = load_v3(candidate)
    rows = load_group_manifest(root, manifest)
    _, validation, _ = split_grouped(
        rows, group_by=meta["group_by"], seed=int(meta["seed"])
    )
    original = {item["file"]: item
                for item in original_report["validation_per_file"]}
    if set(original) != {item["relative_path"] for item in validation}:
        raise ValueError("Saved diagnostic and group split disagree")

    engine = get_feature_engine(root)
    all_rows = []
    keys = [f"{duration:g}s_max_rms" for duration in WINDOW_SECONDS]
    grouped = {"original_full_clip": []}
    grouped.update({key: [] for key in keys})

    for item in validation:
        rel = item["relative_path"]
        old = original[rel]
        expected = item["label"]
        orig_prediction = {
            "expected": expected,
            "raw_top_class": old["raw_top_class"],
            "top_probability": old["top_probability"],
            "top_margin": old["top_margin"],
            "decision_reason": old["decision_reason"],
            "predicted_after_safety_gate": old["predicted_after_safety_gate"],
            "raw_top_matches_label": old["raw_top_matches_label"],
            "accepted_correctly": old["accepted_correctly"],
        }
        prediction = describe_prediction(orig_prediction)
        grouped["original_full_clip"].append({"expected": expected, **prediction})
        entry = {
            "file": rel, "expected": expected,
            "original": {"duration_s": old["duration_s"],
                         "energy_trimmed_duration_s": old["energy_trimmed_duration_s"],
                         **prediction},
            "windows": {},
        }
        samples = read_audio(root / rel, engine)
        for duration, key in zip(WINDOW_SECONDS, keys):
            length = round(duration * SAMPLE_RATE)
            crop, start = max_rms_window(
                samples, length, round(HOP_SECONDS * SAMPLE_RATE)
            )
            try:
                vector = feature_vector(crop, engine)
                scores = infer_probs(vector[None, :], weights)[0]
                result = describe_prediction(
                    decision_from_probabilities(scores, expected)
                )
                # Selection uses waveform RMS only; not the actual word,
                # predicted probabilities, or threshold optimization.
                detail = {
                    "start_s": round(start / SAMPLE_RATE, 4),
                    "end_s": round((start + len(crop)) / SAMPLE_RATE, 4),
                    **result,
                }
                grouped[key].append({"expected": expected, **result})
            except (ValueError, RuntimeError) as exc:
                detail = {
                    "start_s": round(start / SAMPLE_RATE, 4),
                    "feature_error": str(exc),
                }
            entry["windows"][key] = detail
        all_rows.append(entry)

    return {
        "candidate": str(candidate),
        "group_split": original_report["split"],
        "window_lengths_s": list(WINDOW_SECONDS),
        "hop_seconds": HOP_SECONDS,
        "selection": "maximum fixed-window RMS, label-independent, earliest tie",
        "metrics": {
            name: summarize_predictions(items, name)
            for name, items in grouped.items()
        },
        "validation_per_file": all_rows,
        "limitations": [
            "This validation set was already used for V3 checkpoint selection and "
            "diagnostic investigation. It is NOT an independent model test.",
            "The audio-window method is an exploratory counterfactual, not "
            "an operational KWS algorithm or validated speech detector.",
            "Short-window scanning can introduce new false positives on "
            "continuous UNKNOWN speech; inspect all UNKNOWN results.",
            "Window maxima can select loud background noise instead of speech. "
            "Only listening to WAVs can establish what was spoken.",
            "Do not optimize acceptance thresholds or deploy this research output. "
            "Use fresh independent sessions and speakers for final evaluation.",
        ],
        "active_system_changed": False,
        "candidate_retrained": False,
        "legacy_holdout_read": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Read-only maximum-RMS crop sensitivity audit for saved V3 candidate"
    )
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--candidate", type=Path)
    parser.add_argument("--show-files", action="store_true")
    args = parser.parse_args()
    root = args.data.resolve()
    manifest = (args.manifest or (root / "group_manifest_v3.csv")).resolve()
    model = (args.candidate or (
        root / "artifacts" / "noise_augmented_shadow_v3.npz"
    )).resolve()
    try:
        report = run_audit(root, manifest, model)
    except (OSError, KeyError, ValueError, RuntimeError) as exc:
        print(f"[Noise V3 window audit] Cannot analyze: {exc}", file=sys.stderr)
        return 2
    # Emit concise metrics without identifying audio filenames.
    print(json.dumps(report["metrics"], indent=2))
    if args.show_files:
        for row in report["validation_per_file"]:
            if row["expected"] not in ("fire", "police"):
                continue
            print(f"[{row['expected']}] {row['file']}: "
                  f"original={row['original']['raw_top_class']}")
            for method, detail in row["windows"].items():
                print(f"  {method}: top={detail.get('raw_top_class', '?')}, "
                      f"decision={detail.get('decision_reason', 'feature_error')}, "
                      f"start_s={detail['start_s']}")
    out = model.with_suffix(".segmentation-audit.json")
    out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"[Noise V3 window audit] Saved metadata only: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
