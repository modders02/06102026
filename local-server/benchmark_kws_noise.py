"""Measure stationary-noise attenuation and *separate* held-out KWS accuracy.

Example (all WAVs are consented, local, mono PCM16 at 16 kHz):
  python local-server/benchmark_kws_noise.py --noise-only my_room_noise.wav \
      --holdout local-server/kws-holdout-english --profile strong

A lower noise-floor alone is NEVER evidence that emergency words are detected.
The tool leaves active .npy templates unchanged and uploads no recordings.
"""
from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from msds.binaries import resolve_exe  # noqa: E402
from msds.kws_audio_filters import PROFILES, pcm_audio_filter  # noqa: E402
from msds.kws_engine import (  # noqa: E402
    DEFAULT_KEYWORDS, KWS_ENGINE, NEGATIVE_CLASS, SAMPLE_RATE,
)
from msds.kws_verifier import eligible_help_fast_accept  # noqa: E402

MIN_HOLDOUT_WORD = 3
MIN_HOLDOUT_UNKNOWN = 10


def read_pcm_wav(path: Path) -> bytes:
    if not path.is_file():
        raise ValueError(f"No WAV file found: {path}")
    with wave.open(str(path), "rb") as stream:
        if (stream.getnchannels() != 1 or stream.getsampwidth() != 2
                or stream.getframerate() != SAMPLE_RATE
                or stream.getcomptype() != "NONE"):
            raise ValueError(
                f"{path}: expected uncompressed PCM16 mono WAV at 16000 Hz. "
                "Convert a local recording with FFmpeg before benchmarking."
            )
        if stream.getnframes() > SAMPLE_RATE * 300:
            raise ValueError(f"{path}: maximum permitted recording duration is 5 minutes.")
        return stream.readframes(stream.getnframes())


def apply_profile(ffmpeg: str, pcm: bytes, profile: str) -> bytes:
    """Offline process the exact input once, with the live CCTV filter graph."""
    command = [
        ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error",
        "-f", "s16le", "-ar", str(SAMPLE_RATE), "-ac", "1", "-i", "pipe:0",
        "-af", pcm_audio_filter(enabled=True, profile=profile),
        "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1",
    ]
    result = subprocess.run(
        command, input=pcm, capture_output=True, timeout=60, check=False,
    )
    if result.returncode:
        raise RuntimeError(
            "FFmpeg filter failed: " + result.stderr.decode(errors="replace")[-600:]
        )
    if not result.stdout or len(result.stdout) % 2:
        raise RuntimeError("FFmpeg did not return a valid 16-bit PCM stream.")
    if abs(len(result.stdout) - len(pcm)) > 3200:
        raise RuntimeError("FFmpeg output duration changed by more than 100 ms.")
    return result.stdout


def mean_power(pcm: bytes, skip_seconds: float = 1.0) -> float:
    # Ignore startup samples while the FFT noise estimator stabilizes.
    values = np.frombuffer(pcm, dtype="<i2")
    values = values[int(skip_seconds * SAMPLE_RATE):].astype(np.float64)
    if len(values) < SAMPLE_RATE:
        raise ValueError("Need at least 2 seconds of background-only audio.")
    return float(np.mean((values / 32768.0) ** 2))


def noise_power_report(original: bytes, processed: bytes) -> dict:
    before = mean_power(original)
    after = mean_power(processed)
    if before < 1e-9:
        raise ValueError("Noise-only recording is too quiet for a meaningful reduction score.")
    remaining = after / before
    return {
        "definition": "fraction of mean-square signal power removed from a noise-only recording",
        "before_power": round(before, 9),
        "after_power": round(after, 9),
        "remaining_power_pct": round(100 * remaining, 2),
        "noise_power_reduction_pct": round(100 * (1 - remaining), 2),
        "attenuation_db": round(10 * math.log10(before / max(after, 1e-12)), 2),
    }


def predicted_word(pcm: bytes) -> tuple[str | None, str]:
    decision = KWS_ENGINE.diagnose(pcm)
    if decision is None:
        return None, "no_candidate"
    accepted = decision.accepted or eligible_help_fast_accept(decision)
    return decision.keyword if accepted else None, decision.reason


def heldout_report(ffmpeg: str, folder: Path, profile: str) -> dict:
    counts = KWS_ENGINE.status()
    if not counts["open_set_ready"]:
        raise ValueError("KWS templates are not ready. Check /kws/status before benchmarking.")
    results = {}
    positive_correct = 0
    positive_total = 0
    unknown_false = 0
    unknown_total = 0
    adequate = True

    for keyword in (*DEFAULT_KEYWORDS, NEGATIVE_CLASS):
        files = sorted((folder / keyword).glob("*.wav"))
        minimum = MIN_HOLDOUT_UNKNOWN if keyword == NEGATIVE_CLASS else MIN_HOLDOUT_WORD
        if len(files) < minimum:
            adequate = False
        original_correct = 0
        denoised_correct = 0
        errors = []
        for file in files:
            raw = read_pcm_wav(file)
            length_seconds = len(raw) / (SAMPLE_RATE * 2)
            if not 0.30 <= length_seconds <= 2.50:
                raise ValueError(f"{file}: one keyword/negative utterance must last 0.30–2.50 s")
            filtered = apply_profile(ffmpeg, raw, profile)
            original_pred, _ = predicted_word(raw)
            processed_pred, reason = predicted_word(filtered)
            expected = None if keyword == NEGATIVE_CLASS else keyword
            original_correct += int(original_pred == expected)
            denoised_correct += int(processed_pred == expected)
            if processed_pred != expected:
                errors.append({
                    "file": file.name,
                    "predicted": processed_pred,
                    "reason": reason,
                })
        results[keyword] = {
            "samples": len(files),
            "minimum_samples": minimum,
            "raw_correct": original_correct,
            "filtered_correct": denoised_correct,
            "filtered_recall_or_reject_rate": (
                round(denoised_correct / len(files), 3) if files else None
            ),
            "errors": errors,
        }
        if keyword == NEGATIVE_CLASS:
            unknown_total += len(files)
            unknown_false += len(files) - denoised_correct
        else:
            positive_total += len(files)
            positive_correct += denoised_correct

    recall = positive_correct / positive_total if positive_total else 0.0
    false_alarm = unknown_false / unknown_total if unknown_total else 1.0
    return {
        "source": str(folder),
        "adequate_sample_counts": adequate,
        "positive_recall": round(recall, 3),
        "unknown_false_alarm_rate": round(false_alarm, 3),
        "per_keyword": results,
        "passes_90pct_recall_and_5pct_unknown_fpr": (
            adequate and recall >= 0.90 and false_alarm <= 0.05
        ),
        "note": "Clips must be previously unseen, labeled and separate from training; live continuous-audio VAD is evaluated separately.",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Measure KWS stationary-noise power reduction and held-out keyword recall.")
    parser.add_argument("--noise-only", type=Path, required=True, help="Noise-only PCM16 16-kHz mono WAV (no speech).")
    parser.add_argument("--holdout", type=Path, help="Independent WAV set grouped by keyword and unknown folders.")
    parser.add_argument("--profile", choices=sorted(PROFILES), default="strong")
    parser.add_argument("--min-reduction", type=float, default=80.0, help="Noise power attenuation target percent (default 80).")
    args = parser.parse_args()
    if not 0 <= args.min_reduction < 100:
        parser.error("--min-reduction must be between 0 and below 100.")
    ffmpeg = resolve_exe("ffmpeg", "FFMPEG_EXE")
    if not ffmpeg:
        parser.error("FFmpeg unavailable; install local-server/bin/ffmpeg.exe or put it on PATH.")
    try:
        raw = read_pcm_wav(args.noise_only)
        filtered = apply_profile(ffmpeg, raw, args.profile)
        attenuation = noise_power_report(raw, filtered)
        pass_noise = attenuation["noise_power_reduction_pct"] >= args.min_reduction
        validation = heldout_report(ffmpeg, args.holdout, args.profile) if args.holdout else None
        report = {
            "profile": args.profile,
            "noise": attenuation,
            "minimum_noise_power_reduction_pct": args.min_reduction,
            "passes_noise_target": pass_noise,
            "speech_validation": validation,
            "qualified": bool(
                pass_noise and validation and validation["passes_90pct_recall_and_5pct_unknown_fpr"]
            ),
            "production_proven": False,
            "warning": "Synthetic tests or attenuation alone cannot establish live noisy-room KWS accuracy. Keep emergency notifications disabled until field validation.",
        }
        print(json.dumps(report, indent=2))
        return 0 if report["qualified"] else 1
    except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired) as exc:
        print(json.dumps({"qualified": False, "error": str(exc)}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
