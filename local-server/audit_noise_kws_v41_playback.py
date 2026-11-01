"""Interactive local V4.1 audio-quality audit; never modifies source audio or model.

Listen to the original WAV and *exact* V4.1-selected audio on Windows,
before rating a recording. Selection comes from saved frozen model output,
not from transcribing or changing thresholds. Appends only private
per-recording human judgments to a Git-ignored CSV; replay/resume supported.

The earlier 55-WAV set was inspected in V4.1/V5/V3 experiments and cannot
serve as a new unbiased final holdout after this qualitative review.
"""
from __future__ import annotations

import argparse
from collections import Counter
import csv
import hashlib
import json
from pathlib import Path, PurePosixPath
import sys

import numpy as np

from audit_noise_kws_v4_crops import wav_bytes
from audit_noise_kws_v41_failures import validated_frozen_report
from evaluate_noise_kws_v41 import resolve_test_root
from noise_kws_v4_model import load_model
from train_noise_augmented_kws import LABELS, SAMPLE_RATE, read_audio
from train_noise_kws_v3 import DEFAULT_DATA, get_feature_engine
from train_noise_kws_v41 import V41_NAME, feature_for_audio

RESULT_NAME = "noise_temporal_context_v41.independent-evaluation.json"
REVIEW_NAME = "noise_temporal_context_v41.manual-audio-review.csv"
COLUMNS = (
    "file", "sha256", "expected", "review_group",
    "original_seconds", "selected_start_s", "selected_end_s",
    "selected_seconds", "original_expected_word_audible",
    "selected_expected_word_complete", "quality",
)
GROUPS = (
    "wrong-top", "correct-rejected", "unknown-suspicious",
    "accepted-control", "all",
)


def select_rows(entries: list[dict], group: str) -> list[dict]:
    """Do not alter sample order or gate; no auto relabeling of WAVs."""
    if group not in GROUPS:
        raise ValueError(f"Unknown review group: {group}")
    for row in entries:
        if row["expected"] not in LABELS or row["raw_top_class"] not in LABELS:
            raise ValueError("Unrecognized original label or prediction")
    if group == "wrong-top":
        return [r for r in entries if r["expected"] != "unknown"
                and r["raw_top_class"] != r["expected"]]
    if group == "correct-rejected":
        return [r for r in entries if r["expected"] != "unknown"
                and r["raw_top_class"] == r["expected"]
                and r["accepted_class"] == "unknown"]
    if group == "unknown-suspicious":
        return [r for r in entries if r["expected"] == "unknown"
                and r["raw_top_class"] != "unknown"]
    if group == "accepted-control":
        return [r for r in entries if r["expected"] != "unknown"
                and r["accepted_class"] == r["expected"]]
    return list(entries)


def recording_file(test_root: Path, item: dict) -> tuple[Path, str]:
    """Reject traversal, symlink WAVs and substituted class paths."""
    raw = item.get("file")
    if not isinstance(raw, str) or not raw or "\\" in raw:
        raise ValueError("Invalid saved WAV path")
    rel = PurePosixPath(raw)
    if (len(rel.parts) != 3 or rel.parts[0] != "train"
            or rel.parts[1] != item["expected"]
            or rel.suffix.lower() != ".wav"
            or rel.name in ("", ".", "..")):
        raise ValueError(f"Unsafe or mismatched evaluation WAV path: {raw}")
    folder = test_root / "train" / rel.parts[1]
    path = folder / rel.name
    if (not folder.is_dir() or folder.is_symlink() or not path.is_file()
            or path.is_symlink()):
        raise ValueError(f"Missing/symlink source WAV: {path}")
    if path.stat().st_size > 5 * 1024 * 1024:
        raise ValueError(f"Oversized source WAV: {path}")
    return path, hashlib.sha256(path.read_bytes()).hexdigest()


def load_reviews(path: Path) -> dict[str, dict]:
    if not path.exists():
        return {}
    with path.open("r", newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        if tuple(reader.fieldnames or ()) != COLUMNS:
            raise ValueError("Existing private CSV has incompatible columns")
        rows = list(reader)
    if len({r["file"] for r in rows}) != len(rows):
        raise ValueError("Duplicate prior manual reviews")
    if any(r["original_expected_word_audible"] not in ("Y", "N", "U")
           or r["selected_expected_word_complete"] not in ("Y", "N", "U")
           or r["quality"] not in ("C", "S", "N", "U") for r in rows):
        raise ValueError("Invalid prior manual-review decision")
    return {r["file"]: r for r in rows}


def append_review(path: Path, review: dict) -> None:
    if set(review) != set(COLUMNS):
        raise ValueError("Unexpected review CSV columns")
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=COLUMNS, lineterminator="\n")
        if f.tell() == 0:
            writer.writeheader()
        writer.writerow(review)


def audio_diagnostics(samples: np.ndarray, start_s: float, end_s: float) -> tuple[np.ndarray, dict]:
    if not 0 <= start_s < end_s <= len(samples) / SAMPLE_RATE + 0.001:
        raise ValueError("Invalid V4.1 crop bounds")
    left = round(start_s * SAMPLE_RATE)
    right = min(len(samples), round(end_s * SAMPLE_RATE))
    clip = samples[left:right].copy()
    if clip.size < SAMPLE_RATE // 10:
        raise ValueError("Unreasonably short V4.1 segment")
    original_rms = float(np.sqrt(np.mean(np.square(samples, dtype=np.float64))))
    selected_rms = float(np.sqrt(np.mean(np.square(clip, dtype=np.float64))))
    return clip, {
        "full_seconds": round(len(samples) / SAMPLE_RATE, 4),
        "selected_seconds": round(len(clip) / SAMPLE_RATE, 4),
        "selected_fraction": round(len(clip) / len(samples), 4),
        "full_rms": round(original_rms, 6),
        "selected_rms": round(selected_rms, 6),
        "full_peak": round(float(np.max(np.abs(samples))), 6),
        "near_clipped_fraction": round(float(np.mean(np.abs(samples) >= 0.98)), 6),
    }


def ask_rating(prompt: str, allowed: str, replay) -> str:
    while True:
        ans = input(prompt).strip().upper()
        if ans == "R":
            replay()
        elif ans == "Q" or ans in allowed:
            return ans
        else:
            print(f"Choose one of {', '.join(allowed)} or R=replay, Q=quit.")


def summarize_review(reviews: dict[str, dict], selected_files: set[str]) -> None:
    subset = [v for k, v in reviews.items() if k in selected_files]
    original = Counter(x["original_expected_word_audible"] for x in subset)
    extracted = Counter(x["selected_expected_word_complete"] for x in subset)
    quality = Counter(x["quality"] for x in subset)
    print(json.dumps({
        "reviewed_in_selection": len(subset),
        "audible_expected_word_in_full": dict(original),
        "complete_expected_word_in_v41_segment": dict(extracted),
        "quality": dict(quality),
        "note": (
            "For UNKNOWN clips, Y means an emergency keyword was heard. "
            "These are subjective operator labels, not independent truth. "
            "Do not tune model or acceptance gate against this reviewed cohort."
        ),
    }, indent=2))


def main() -> int:
    parser = argparse.ArgumentParser(description="Windows local full-vs-V4.1 selection listening review")
    parser.add_argument("--test-data", type=Path, required=True)
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA)
    parser.add_argument("--candidate", type=Path)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--review-csv", type=Path)
    parser.add_argument("--group", choices=GROUPS, default="wrong-top")
    parser.add_argument("--check", action="store_true",
                        help="Verify inputs and list clips without playing")
    args = parser.parse_args()
    root = args.data.resolve()
    test_root = resolve_test_root(root, args.test_data.resolve())
    candidate = (args.candidate or root / "artifacts" / V41_NAME).resolve()
    report_path = (args.report or root / "artifacts" / RESULT_NAME).resolve()
    output = (args.review_csv or root / "artifacts" / REVIEW_NAME).resolve()
    if output.suffix.lower() != ".csv" or output == report_path:
        parser.error("Private output must be a distinct CSV path")

    try:
        _, metadata = load_model(candidate)
        report = json.loads(report_path.read_text(encoding="utf-8"))
        entries = validated_frozen_report(report, metadata)
        selected = select_rows(entries, args.group)
        if not selected:
            raise ValueError("No WAVs match this review group")
        reviews = load_reviews(output)
        # Verify every prior review, even if today's review group differs.
        reference = {r["file"]: r for r in entries}
        for rel, prior in reviews.items():
            if rel not in reference:
                raise ValueError(f"Stale manual review not in frozen report: {rel}")
            f, sha = recording_file(test_root, reference[rel])
            if prior["sha256"] != sha:
                raise ValueError(f"Previously reviewed WAV contents changed: {f}")
        files = [(row, *recording_file(test_root, row)) for row in selected]
        if len({row["file"] for row, _, _ in files}) != len(files):
            raise ValueError("Duplicate WAV paths in saved V4.1 report")
        remaining = [x for x in files if x[0]["file"] not in reviews]
        print(
            f"[V4.1 listen] group={args.group} selected={len(files)} "
            f"reviewed={len(files)-len(remaining)} remaining={len(remaining)}"
        )
        if args.check:
            for item, _, _ in files:
                print(f"  {item['expected'].upper():10s} {item['file']}")
            return 0
        try:
            import winsound
        except ImportError as exc:
            raise RuntimeError("Interactive playback requires Windows Python winsound") from exc
        extractor = get_feature_engine(root)
        for num, (row, path, digest) in enumerate(remaining, 1):
            samples = read_audio(path, extractor)
            _, segment = feature_for_audio(samples, extractor)
            extracted, acoustics = audio_diagnostics(
                samples, segment["start_s"], segment["end_s"]
            )
            if not np.isfinite(samples).all():
                raise ValueError(f"Nonfinite WAV values: {path}")
            full_pcm, selected_pcm = wav_bytes(samples), wav_bytes(extracted)
            print(
                f"\n[{num}/{len(remaining)}] Expected={row['expected'].upper()} "
                f"full={acoustics['full_seconds']}s "
                f"V4.1 segment={segment['start_s']}..{segment['end_s']}s "
                f"({acoustics['selected_fraction']*100:.1f}% retained) "
                f"RMS={acoustics['full_rms']:.4f}"
            )
            def replay():
                print("[V4.1 listen] ORIGINAL full WAV...")
                winsound.PlaySound(full_pcm, winsound.SND_MEMORY)
                print("[V4.1 listen] V4.1 SELECTED SEGMENT...")
                winsound.PlaySound(selected_pcm, winsound.SND_MEMORY)
            replay()
            if row["expected"] == "unknown":
                q1 = "Any of the SEVEN emergency words audible in the FULL UNKNOWN WAV? [Y/N/U/R/Q] "
                q2 = "Any emergency word audible in the V4.1 SEGMENT? [Y/N/U/R/Q] "
            else:
                q1 = "Does FULL WAV contain the COMPLETE EXPECTED word? [Y/N/U/R/Q] "
                q2 = "Does V4.1 SEGMENT preserve the COMPLETE EXPECTED word? [Y/N/U/R/Q] "
            original = ask_rating(q1, "YNU", replay)
            if original == "Q":
                break
            selected_word = ask_rating(q2, "YNU", replay)
            if selected_word == "Q":
                break
            quality = ask_rating(
                "Sound quality: C=clear, S=soft/quiet, N=noisy/distorted, U=uncertain [C/S/N/U/R/Q] ",
                "CSNU", replay,
            )
            if quality == "Q":
                break
            append_review(output, {
                "file": row["file"], "sha256": digest,
                "expected": row["expected"], "review_group": args.group,
                "original_seconds": str(acoustics["full_seconds"]),
                "selected_start_s": str(segment["start_s"]),
                "selected_end_s": str(segment["end_s"]),
                "selected_seconds": str(acoustics["selected_seconds"]),
                "original_expected_word_audible": original,
                "selected_expected_word_complete": selected_word,
                "quality": quality,
            })
            reviews[row["file"]] = {
                **reviews.get(row["file"], {}),
                "original_expected_word_audible": original,
                "selected_expected_word_complete": selected_word,
                "quality": quality,
            }
            print("[V4.1 listen] Private review saved. No original audio written or changed.")
        summarize_review(reviews, {row["file"] for row, _, _ in files})
        print(f"[V4.1 listen] Private review CSV: {output}")
        return 0
    except (OSError, ValueError, RuntimeError, KeyError, TypeError) as exc:
        print(f"[V4.1 listen] Aborted: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
