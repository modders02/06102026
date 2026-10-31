"""Read-only V4 crop context preservation listening experiment.

Audits only recordings the operator previously marked N (incomplete word).
Replays full ORIGINAL followed by the same original V4 crop enlarged by
550 ms on each side (bounded to the original WAV). A label-blind method:
no expected label, model probability or audio file content drives the bounds.
Never retrains models, changes templates, uploads/saves audio, or drives alerts.
"""
from __future__ import annotations

import argparse
from collections import Counter
import csv
from pathlib import Path
import sys

import numpy as np

from audit_noise_kws_v4_crops import (
    load_reviews, play_original_then_crop, report_and_validation, wav_bytes,
)
from noise_kws_v4_audio import localize_speech_candidate
from train_noise_augmented_kws import SAMPLE_RATE, read_audio
from train_noise_kws_v3 import DEFAULT_DATA, get_feature_engine
from train_noise_kws_v4 import V4_NAME

PADDING_SECONDS = 0.55  # predetermined exploratory setting, not a fitted threshold
COLUMNS = (
    "relative_path", "sha256", "label", "baseline_crop_start_s",
    "baseline_crop_end_s", "expanded_start_s", "expanded_end_s",
    "expanded_duration_s", "context_seconds", "complete_word",
)


def expand_crop_bounds(
    original: np.ndarray,
    baseline_start_s: float,
    baseline_end_s: float,
    *,
    sample_rate: int = SAMPLE_RATE,
    padding_seconds: float = PADDING_SECONDS,
) -> tuple[np.ndarray, dict]:
    """Expand the baseline crop with fixed symmetric context, no prediction data.

    Never extends beyond the original waveform or time-stretches/resamples it.
    This tool is for human listening only; V4 remains unchanged.
    """
    signal = np.asarray(original, np.float32)
    if signal.ndim != 1 or not len(signal) or not np.isfinite(signal).all():
        raise ValueError("Expected nonempty finite mono audio")
    if sample_rate <= 0:
        raise ValueError("Invalid baseline crop or symmetric context")
    total_seconds = len(signal) / sample_rate
    if (not np.isfinite(baseline_start_s)
            or not np.isfinite(baseline_end_s)
            or not 0 <= baseline_start_s < baseline_end_s <= total_seconds + 0.001
            or not 0 < padding_seconds <= 1.0):
        raise ValueError("Invalid baseline crop or symmetric context")
    start = max(0, int(round((baseline_start_s - padding_seconds) * sample_rate)))
    end = min(len(signal), int(round((baseline_end_s + padding_seconds) * sample_rate)))
    if end <= start:
        raise ValueError("Cannot form expanded crop")
    selected = signal[start:end].copy()
    return selected, {
        "start_s": round(start / sample_rate, 4),
        "end_s": round(end / sample_rate, 4),
        "duration_s": round((end - start) / sample_rate, 4),
        "context_seconds": padding_seconds,
    }


def load_context_reviews(path: Path) -> dict[str, dict]:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        if tuple(reader.fieldnames or ()) != COLUMNS:
            raise ValueError("Context-review CSV has unsupported columns")
        rows = list(reader)
    if len({row["relative_path"] for row in rows}) != len(rows):
        raise ValueError("Duplicate context-review entries")
    if any(row["complete_word"] not in ("Y", "N", "U") for row in rows):
        raise ValueError("Unrecognized context-review decision")
    return {row["relative_path"]: row for row in rows}


def append_context_review(path: Path, values: dict) -> None:
    if set(values) != set(COLUMNS):
        raise ValueError("Context-review values do not match columns")
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=COLUMNS, lineterminator="\n")
        if handle.tell() == 0:
            writer.writeheader()
        writer.writerow(values)


def select_incomplete(
    validation: list[dict], original_reviews: dict[str, dict],
    existing: dict[str, dict],
) -> list[dict]:
    indexed = {row["relative_path"]: row for row in validation}
    for rel, review in original_reviews.items():
        if rel not in indexed or review["sha256"] != indexed[rel]["sha256"]:
            raise ValueError(f"Old review does not match current validation WAV: {rel}")
    selected = []
    for rel, review in sorted(original_reviews.items()):
        if review["crop_complete_word"] != "N":
            continue
        if rel in existing:
            if (existing[rel]["sha256"] != indexed[rel]["sha256"] or
                    existing[rel]["context_seconds"] != str(PADDING_SECONDS)):
                raise ValueError(f"Existing context review has different audio/context: {rel}")
            continue
        selected.append(indexed[rel])
    for rel, review in existing.items():
        if (rel not in original_reviews or
                original_reviews[rel]["crop_complete_word"] != "N" or
                rel not in indexed or
                review["sha256"] != indexed[rel]["sha256"]):
            raise ValueError(f"Context review is stale or was not originally marked N: {rel}")
    return selected


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Private listening test: original vs widened V4 crop, no training"
    )
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA)
    parser.add_argument("--candidate", type=Path)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--crop-review", type=Path)
    parser.add_argument("--output-csv", type=Path)
    args = parser.parse_args()
    root = args.data.resolve()
    model = (args.candidate or root / "artifacts" / V4_NAME).resolve()
    manifest = (args.manifest or root / "group_manifest_v3.csv").resolve()
    crop_reviews = (args.crop_review or root / "artifacts" /
                    "noise_temporal_cnn_v4.crop-review.csv").resolve()
    output = (args.output_csv or root / "artifacts" /
              "noise_temporal_cnn_v4.context-review.csv").resolve()
    if output.suffix.lower() != ".csv" or output == crop_reviews:
        parser.error("Use a separate .csv output for context ratings")

    try:
        validation, _, split = report_and_validation(root, model, manifest)
        originals = load_reviews(crop_reviews)
        if not originals:
            raise ValueError("No completed original crop review. Run audit_noise_kws_v4_crops.cmd first.")
        previous = load_context_reviews(output)
        selected = select_incomplete(validation, originals, previous)
        all_marked_n = sum(
            r["crop_complete_word"] == "N" for r in originals.values()
        )
        print(
            f"[Context audit] Previous incomplete crops: {all_marked_n}; "
            f"already context-reviewed: {len(previous)}; remaining: {len(selected)}"
        )
        print(
            "[Context audit] Fixed +0.55s before/after original V4 crop. "
            "Listen to ORIGINAL then CONTEXT; Y=complete expected word, "
            "N=still missing, U=uncertain, R=replay, Q=stop."
        )
        if not selected:
            show_summary(previous)
            return 0
        try:
            import winsound
        except ImportError as exc:
            raise RuntimeError("Windows winsound required for private playback") from exc
        extractor = get_feature_engine(root)
        for i, row in enumerate(selected, 1):
            rel = row["relative_path"]
            recorded = originals[rel]
            samples = read_audio(root / rel, extractor)
            _, baseline = localize_speech_candidate(samples)
            # Detect changes in localization code or CSV; do not silently
            # compare a different algorithm to historical manual labels.
            if (abs(baseline["start_s"] - float(recorded["crop_start_s"])) > 0.02
                    or abs(baseline["end_s"] - float(recorded["crop_end_s"])) > 0.02):
                raise ValueError(
                    f"Baseline crop differs from previously reviewed V4 crop: {rel}"
                )
            selected_audio, new = expand_crop_bounds(
                samples, baseline["start_s"], baseline["end_s"]
            )
            print(
                f"\n[{i}/{len(selected)}] {row['label'].upper()} | "
                f"old={baseline['start_s']:.2f}..{baseline['end_s']:.2f}s | "
                f"expanded={new['start_s']:.2f}..{new['end_s']:.2f}s "
                f"out of {len(samples)/SAMPLE_RATE:.2f}s"
            )
            original_bytes, expanded_bytes = wav_bytes(samples), wav_bytes(selected_audio)
            while True:
                play_original_then_crop(winsound, original_bytes, expanded_bytes)
                answer = input(
                    "Does the expanded crop retain the COMPLETE expected word? "
                    "[Y/N/U/R/Q] "
                ).strip().upper()
                if answer in ("Y", "N", "U", "Q"):
                    break
                if answer != "R":
                    print("[Context audit] Enter Y, N, U, R or Q.")
            if answer == "Q":
                print("[Context audit] Stopped; all prior reviews remain saved.")
                break
            result = {
                "relative_path": rel,
                "sha256": row["sha256"],
                "label": row["label"],
                "baseline_crop_start_s": str(baseline["start_s"]),
                "baseline_crop_end_s": str(baseline["end_s"]),
                "expanded_start_s": str(new["start_s"]),
                "expanded_end_s": str(new["end_s"]),
                "expanded_duration_s": str(new["duration_s"]),
                "context_seconds": str(PADDING_SECONDS),
                "complete_word": answer,
            }
            append_context_review(output, result)
            previous[rel] = result
        show_summary(previous)
        print(f"[Context audit] Private review metadata: {output}")
        print(
            "[Context audit] No WAVs, models, V3/V4 artifacts, "
            "enrolled DTW templates or alerts changed."
        )
        return 0
    except (OSError, ValueError, RuntimeError, KeyError) as exc:
        print(f"[Context audit] Aborted: {exc}", file=sys.stderr)
        return 2


def show_summary(reviews: dict[str, dict]) -> None:
    for label in ("emergency", "intruder", "fire"):
        selected = [x for x in reviews.values() if x["label"] == label]
        if not selected:
            continue
        counts = Counter(row["complete_word"] for row in selected)
        print(
            f"[Context audit] {label.upper()}: "
            f"Y={counts['Y']} N={counts['N']} U={counts['U']}"
        )


if __name__ == "__main__":
    raise SystemExit(main())
