"""Private, local playback audit of V4's automatically localized speech segments.

Plays the already-verified ORIGINAL WAV and the V4-extracted CROP back to back
for the human operator to assess. Does NOT train, change a model, optimize a
threshold, touch DTW enrollment/templates, change event history or send alerts.

No WAVs are created, copied, uploaded or saved; only a private CSV of manual
judgments is appended under the Git-ignored artifacts directory.
"""
from __future__ import annotations

import argparse
from collections import Counter
import csv
import hashlib
import io
import json
from pathlib import Path
import sys
import wave

import numpy as np

from noise_kws_v3_groups import load_group_manifest, split_grouped
from noise_kws_v4_audio import localize_speech_candidate
from noise_kws_v4_model import load_model
from train_noise_augmented_kws import LABELS, SAMPLE_RATE, read_audio
from train_noise_kws_v3 import DEFAULT_DATA, get_feature_engine
from train_noise_kws_v4 import V4_NAME

COLUMNS = (
    "relative_path", "sha256", "label", "original_duration_s",
    "crop_start_s", "crop_end_s", "crop_duration_s", "crop_reason",
    "crop_complete_word", "v4_raw_top", "v4_accepted",
    "v4_decision_reason",
)
DEFAULT_LABELS = ("emergency", "intruder", "fire")


def wav_bytes(samples: np.ndarray, sample_rate: int = SAMPLE_RATE) -> bytes:
    """Create a standard PCM16 WAV in memory for Windows synchronous playback."""
    a = np.asarray(samples, dtype=np.float32)
    if a.ndim != 1 or not len(a) or not np.isfinite(a).all():
        raise ValueError("Expected finite nonempty mono samples")
    if sample_rate < 8000 or sample_rate > 48000:
        raise ValueError("Unsupported playback sample rate")
    pcm = (np.clip(a, -1.0, 0.999969) * 32767).astype("<i2").tobytes()
    memory = io.BytesIO()
    with wave.open(memory, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(sample_rate)
        out.writeframes(pcm)
    return memory.getvalue()


def play_original_then_crop(winsound_module, original_wav: bytes, crop_wav: bytes) -> None:
    """Play two WAV buffers synchronously without writing temporary audio files.

    The winsound PlaySound() default is synchronous. Python's winsound does
    not export SND_SYNC; passing SND_MEMORY *without* SND_ASYNC is sufficient.
    """
    flags = winsound_module.SND_MEMORY
    print("[Crop review] Playing ORIGINAL...")
    winsound_module.PlaySound(original_wav, flags)
    print("[Crop review] Playing V4 CROP...")
    winsound_module.PlaySound(crop_wav, flags)


def report_and_validation(root: Path, model_path: Path, manifest: Path):
    """Require unchanged saved model, grouped train/validation membership and WAVs."""
    model, meta = load_model(model_path)
    if not bool(meta.get("research_only")) or tuple(meta.get("labels", [])) != LABELS:
        raise ValueError("Candidate must be a V4 research-only model with matching labels")
    report_path = model_path.with_suffix(".report.json")
    with report_path.open("r", encoding="utf-8") as handle:
        report = json.load(handle)
    if meta != report.get("model_metadata"):
        raise ValueError("V4 model and training report metadata do not match")
    rows = load_group_manifest(root, manifest)
    training, validation, split = split_grouped(
        rows, group_by=meta["group_by"], seed=int(meta["seed"])
    )
    dataset = report["dataset"]
    for name, actual in (
        ("validation_relative_path_sha256", validation),
        ("original_train_relative_path_sha256", training),
    ):
        signature = hashlib.sha256(
            "\n".join(sorted(row["relative_path"] for row in actual)).encode("utf-8")
        ).hexdigest()
        if dataset.get(name) != signature:
            raise ValueError(f"Current files do not match V4 saved {name}")
    if (len(training) != dataset.get("original_train_wavs") or
            len(validation) != dataset.get("original_session_validation_wavs")):
        raise ValueError("V4 saved train/validation counts changed")
    decisions = report["session_validation"]["validation_per_file"]
    index = {row["file"]: row for row in decisions}
    if len(index) != len(validation) or set(index) != {
        r["relative_path"] for r in validation
    }:
        raise ValueError("V4 report classification rows differ from validation WAVs")
    if any(index[r["relative_path"]]["expected"] != r["label"] for r in validation):
        raise ValueError("V4 report labels differ from manifest")
    # A local model is merely validated, never altered by this program.
    return validation, index, split


def load_reviews(out: Path) -> dict[str, dict]:
    if not out.exists():
        return {}
    with out.open("r", newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        if tuple(reader.fieldnames or ()) != COLUMNS:
            raise ValueError("Existing manual-review CSV has incompatible columns")
        rows = list(reader)
    if len({r["relative_path"] for r in rows}) != len(rows):
        raise ValueError("Duplicate manual reviews in CSV")
    if any(r["crop_complete_word"] not in ("Y", "N", "U") for r in rows):
        raise ValueError("Manual-review CSV contains unsupported decision")
    return {r["relative_path"]: r for r in rows}


def append_review(out: Path, row: dict) -> None:
    if set(row) != set(COLUMNS):
        raise ValueError("Incorrect review columns")
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("a", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=COLUMNS, lineterminator="\n")
        if handle.tell() == 0:
            writer.writeheader()
        writer.writerow(row)


def render_summary(reviews: dict[str, dict]) -> None:
    for label in LABELS:
        selected = [
            row for row in reviews.values() if row["label"] == label
        ]
        if not selected:
            continue
        counts = Counter(row["crop_complete_word"] for row in selected)
        print(
            f"[Crop review] {label.upper()}: "
            f"Y={counts['Y']}, N={counts['N']}, U={counts['U']} "
            f"(total={len(selected)})"
        )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Listen to original and V4 crop; save private manual labels"
    )
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--candidate", type=Path)
    parser.add_argument("--review-csv", type=Path)
    parser.add_argument("--label", action="append", choices=LABELS,
                        help="Repeat to review several labels; default EMERGENCY, INTRUDER, FIRE")
    parser.add_argument("--only-errors", action="store_true",
                        help="Only replay words that V4 did not accept correctly")
    parser.add_argument("--limit", type=int, default=5,
                        help="Maximum WAVs per selected label (default 5)")
    args = parser.parse_args()
    if not 1 <= args.limit <= 100:
        parser.error("--limit must be 1..100 per label")

    root = args.data.resolve()
    manifest = (args.manifest or root / "group_manifest_v3.csv").resolve()
    candidate = (args.candidate or root / "artifacts" / V4_NAME).resolve()
    out = (args.review_csv or root / "artifacts" /
           "noise_temporal_cnn_v4.crop-review.csv").resolve()
    if out.suffix.lower() != ".csv":
        parser.error("Review output must be a .csv file")
    labels = tuple(dict.fromkeys(args.label or DEFAULT_LABELS))

    try:
        validation, predictions, split = report_and_validation(
            root, candidate, manifest
        )
        reviews = load_reviews(out)
        # Read/verify any earlier review file contents against original hashes.
        expected = {item["relative_path"]: item for item in validation}
        for rel, prior in reviews.items():
            if rel not in expected or prior["sha256"] != expected[rel]["sha256"]:
                raise ValueError(f"Prior review does not match current WAV: {rel}")
        chosen = [
            item for label in labels
            for item in validation if item["label"] == label
        ]
        if args.only_errors:
            chosen = [
                row for row in chosen if not predictions[
                    row["relative_path"]]["correct_accepted"]
            ]
        # Selection is sorted by manifest path and deterministic. 
        selected, per_class = [], Counter()
        for item in chosen:
            if per_class[item["label"]] >= args.limit:
                continue
            selected.append(item)
            per_class[item["label"]] += 1

        print(
            f"[Crop review] V4 SAME-SPEAKER session validation; "
            f"{len(selected)} selected; {len(reviews)} previously reviewed. "
            "The V4 model is frozen and will not be changed."
        )
        print(
            "[Crop review] Listen to the full original and then the short V4 crop. "
            "Y=whole correct word retained, N=missing/clipped/wrong segment, "
            "U=uncertain, R=replay, Q=stop."
        )
        if not selected:
            raise ValueError("No WAVs match requested labels/options")
        engine = get_feature_engine(root)

        try:
            import winsound
        except ImportError as exc:
            raise RuntimeError("Playback requires Windows PowerShell and winsound") from exc

        for number, item in enumerate(selected, 1):
            rel = item["relative_path"]
            if rel in reviews:
                print(f"[Crop review] Already reviewed: {rel} ({reviews[rel]['crop_complete_word']})")
                continue
            samples = read_audio(root / rel, engine)
            crop, meta = localize_speech_candidate(samples)
            # Never print model predictions before manual audio judgment.
            print(
                f"\n[{number}/{len(selected)}] Expected {item['label'].upper()} | "
                f"full={len(samples)/SAMPLE_RATE:.2f}s | "
                f"crop={meta['start_s']:.2f}..{meta['end_s']:.2f}s"
            )
            original_bytes, crop_bytes = wav_bytes(samples), wav_bytes(crop)
            while True:
                play_original_then_crop(winsound, original_bytes, crop_bytes)
                decision = input(
                    "Does the CROP retain the COMPLETE expected word? "
                    "[Y/N/U/R/Q] "
                ).strip().upper()
                if decision in ("Y", "N", "U", "Q"):
                    break
                if decision != "R":
                    print("[Crop review] Enter Y, N, U, R or Q.")
            if decision == "Q":
                print("[Crop review] Stopped without modifying any existing WAV.")
                break
            prediction = predictions[rel]
            review = {
                "relative_path": rel,
                "sha256": item["sha256"],
                "label": item["label"],
                "original_duration_s": f"{len(samples)/SAMPLE_RATE:.4f}",
                "crop_start_s": str(meta["start_s"]),
                "crop_end_s": str(meta["end_s"]),
                "crop_duration_s": str(meta["duration_s"]),
                "crop_reason": meta["reason"],
                "crop_complete_word": decision,
                "v4_raw_top": prediction["raw_top_class"],
                "v4_accepted": prediction["accepted_class"],
                "v4_decision_reason": prediction["decision_reason"],
            }
            append_review(out, review)
            reviews[rel] = review
            print(
                f"[Crop review] Saved {decision}; "
                f"V4 raw={prediction['raw_top_class']} "
                f"accepted={prediction['accepted_class']} "
                f"reason={prediction['decision_reason']}"
            )
        render_summary(reviews)
        print(f"[Crop review] Private review CSV: {out}")
        print("[Crop review] No NPZ, WAV, training data, templates or alerts changed.")
        return 0
    except (OSError, ValueError, RuntimeError, KeyError) as exc:
        print(f"[Crop review] Aborted: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
