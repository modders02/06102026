"""Read-only diagnostics for the isolated noise-augmented KWS candidate.

This does not train, tune thresholds, adjust labels or deploy anything.
A file-level report separates wrong classes from low-confidence rejections.
Comparing repeated experiments to the same holdout can bias model selection;
collect a new, independent test set after making training changes.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import json
from pathlib import Path
import sys

import numpy as np

from msds.kws_engine import CustomKeywordEngine, SAMPLE_RATE
from prepare_neural_kws import ROOT
from train_noise_augmented_kws import (
    ACCEPT_MARGIN, ACCEPT_THRESHOLD, LABELS, feature_vector, infer_probs,
    load_model, predict_one, read_audio, wavs,
)


def explain_decision(probabilities: np.ndarray) -> str:
    """Explain why the current fixed-threshold candidate rejects a sample."""
    best_index = int(np.argmax(probabilities))
    best = float(probabilities[best_index])
    second = float(np.partition(probabilities, -2)[-2])
    if LABELS[best_index] == "unknown":
        return "top_class_unknown"
    if best < ACCEPT_THRESHOLD:
        return "below_fixed_threshold"
    if best - second < ACCEPT_MARGIN:
        return "below_fixed_margin"
    return "accepted"


def diagnose_files(data_root: Path, split: str, weights: dict,
                   extractor: CustomKeywordEngine) -> dict:
    """Classify original real WAVs without noise augmentation."""
    if split not in ("train", "holdout"):
        raise ValueError("Only train/holdout splits are supported")
    samples = []
    for label in LABELS:
        for file in wavs(data_root / split / label):
            raw = read_audio(file, extractor)
            vector = feature_vector(raw, extractor)
            probabilities = infer_probs(vector.reshape(1, -1), weights)[0]
            prediction, confidence, margin = predict_one(vector, weights)
            ranking = np.argsort(probabilities)[::-1][:3]
            raw_top = LABELS[int(ranking[0])]
            samples.append({
                "file": f"{split}/{label}/{file.name}",
                "actual": label,
                "predicted": prediction,
                "raw_top_class": raw_top,
                "correct": prediction == label,
                "decision_reason": explain_decision(probabilities),
                "top_probability": round(float(confidence), 5),
                "margin": round(float(margin), 5),
                "top_three": [
                    {"class": LABELS[int(i)], "probability": round(float(probabilities[i]), 5)}
                    for i in ranking
                ],
                "duration_s": round(len(raw) / SAMPLE_RATE, 3),
                "rms": round(float(np.sqrt(np.mean(raw * raw) + 1e-12)), 5),
                "peak": round(float(np.max(np.abs(raw))), 5),
            })
    counts = Counter(item["decision_reason"] for item in samples)
    per_label = {}
    for label in LABELS:
        selected = [item for item in samples if item["actual"] == label]
        per_label[label] = {
            "files": len(selected),
            "correct": sum(item["correct"] for item in selected),
            "predicted_unknown": sum(item["predicted"] == "unknown" for item in selected),
            "wrong_accepted_word": sum(
                item["predicted"] != label and item["predicted"] != "unknown"
                for item in selected
            ),
        }
    return {
        "split": split,
        "total": len(samples),
        "correct": sum(item["correct"] for item in samples),
        "decisions": dict(sorted(counts.items())),
        "per_label": per_label,
        "file_predictions": samples,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Read-only probability/error analysis for trained noise-KWS candidate."
    )
    parser.add_argument("--data", type=Path, default=ROOT / "neural-kws-data")
    parser.add_argument("--candidate", type=Path, default=None)
    parser.add_argument("--split", choices=("train", "holdout", "both"), default="train")
    parser.add_argument("--show-files", action="store_true",
                        help="Print filenames and top class/probabilities, not audio.")
    args = parser.parse_args()
    root = args.data.resolve()
    model = args.candidate or (root / "artifacts" / "noise_augmented_shadow.npz")
    try:
        weights, metadata = load_model(model)
        extractor = CustomKeywordEngine(data_dir=str(root / "_feature-only-no-enrollments"))
        splits = ["train", "holdout"] if args.split == "both" else [args.split]
        results = {split: diagnose_files(root, split, weights, extractor) for split in splits}
    except (OSError, ValueError, RuntimeError, KeyError) as exc:
        print(f"[Noise diagnose] Could not inspect candidate: {exc}", file=sys.stderr)
        return 2
    summary = {
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "candidate": str(model),
        "trained_version": metadata.get("version"),
        "fixed_accept_threshold": ACCEPT_THRESHOLD,
        "fixed_accept_margin": ACCEPT_MARGIN,
        "splits": {
            split: {k: v for k, v in result.items() if k != "file_predictions"}
            for split, result in results.items()
        },
        "warning": (
            "File labels are assumed, not verified by automatic audio quality checks. "
            "This report does NOT tune the classifier or authorize use in safety alerts. "
            "If holdout predictions inform future improvements, reserve a NEW independent "
            "unseen evaluation set for any subsequent generalization claims."
        ),
    }
    print(json.dumps(summary, indent=2))
    if args.show_files:
        for split, result in results.items():
            for item in result["file_predictions"]:
                print(
                    f"[{split}] {item['file']} expected={item['actual']} "
                    f"predicted={item['predicted']} raw_top={item['raw_top_class']} "
                    f"p={item['top_probability']:.3f} "
                    f"reason={item['decision_reason']}"
                )
    target = root / "artifacts" / "noise_diagnostic_report.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps({**summary, "results": results}, indent=2), encoding="utf-8")
    print(f"[Noise diagnose] Read-only report: {target} (no audio; no enrollment changes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
