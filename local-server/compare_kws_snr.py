"""Offline comparison of the stable KWS and opt-in noisy-room filter.

Use CONSENTED held-out recordings that were not used for template enrollment.
Mix room noise at declared SNRs and run the same frozen keyword templates with
the stable (off) and optional FFmpeg filtering profiles. This evaluates
classifier decisions on pre-segmented clips; it does NOT measure live VAD
recall, microphone distance, or real-world emergency reliability.

Example:
  python local-server/compare_kws_snr.py --holdout local-server/kws-holdout-english \\
      --noise-only room-noise.wav --snrs 20 15 10 5 0 --profiles off standard strong maximum

No files, templates, thresholds, or camera settings are modified.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from benchmark_kws_noise import (  # noqa: E402
    MIN_HOLDOUT_UNKNOWN,
    MIN_HOLDOUT_WORD,
    apply_profile,
    predicted_word,
    read_pcm_wav,
)
from msds.binaries import resolve_exe  # noqa: E402
from msds.kws_engine import DEFAULT_KEYWORDS, KWS_ENGINE, NEGATIVE_CLASS, SAMPLE_RATE  # noqa: E402

LEVELS = (20, 15, 10, 5, 0)
PROFILES = ("off", "standard", "strong", "maximum")


def _float_pcm(pcm: bytes) -> np.ndarray:
    if len(pcm) % 2:
        raise ValueError("Expected aligned 16-bit PCM.")
    return np.frombuffer(pcm, dtype="<i2").astype(np.float64) / 32768.0


def mix_at_snr(
    speech_pcm: bytes,
    noise_pcm: bytes,
    snr_db: float,
    *,
    seed: int = 2026,
    warmup_seconds: float = 1.0,
) -> tuple[bytes, int, int]:
    """Add room noise at an RMS-defined SNR with a leading noise-only warmup.

    The warmup lets a streaming spectral denoiser estimate ambient noise
    before the utterance. Returned sample indices bound the original clip.
    """
    speech = _float_pcm(speech_pcm)
    noise = _float_pcm(noise_pcm)
    if not math.isfinite(snr_db) or not 0 <= warmup_seconds <= 5:
        raise ValueError("SNR and warmup must be finite with warmup 0-5 seconds.")
    if len(speech) < int(0.3 * SAMPLE_RATE) or len(noise) < 2 * SAMPLE_RATE:
        raise ValueError("Need >=0.3s speech and >=2s recorded room noise.")
    signal_power = float(np.mean(speech ** 2))
    noise_power = float(np.mean(noise ** 2))
    if signal_power <= 1e-8 or noise_power <= 1e-9:
        raise ValueError("Speech and room-noise recordings must contain measurable sound.")

    start = round(warmup_seconds * SAMPLE_RATE)
    length = start + len(speech)
    rng = np.random.default_rng(seed)
    offset = int(rng.integers(0, len(noise)))
    indexes = (np.arange(length, dtype=np.int64) + offset) % len(noise)
    selected_noise = noise[indexes]
    desired_noise_power = signal_power / (10 ** (snr_db / 10))
    selected_power = float(np.mean(selected_noise[start:] ** 2))
    if selected_power <= 1e-10:
        raise ValueError("Selected room noise is too quiet to establish SNR.")
    selected_noise *= math.sqrt(desired_noise_power / selected_power)

    mixed = selected_noise
    mixed[start:] += speech
    peak = float(np.max(np.abs(mixed)))
    if peak > 0.98:
        # Scale both noise and speech together so clipping does not create
        # artificial spectral patterns and the target SNR stays unchanged.
        mixed *= 0.98 / peak
    return (np.round(np.clip(mixed, -1, 1) * 32767).astype("<i2").tobytes(),
            start, length)


def compare(
    ffmpeg: str,
    holdout: Path,
    noise_pcm: bytes,
    snrs: tuple[float, ...] = LEVELS,
    profiles: tuple[str, ...] = PROFILES,
    max_files: int = 10,
    seed: int = 2026,
) -> dict:
    if max_files < MIN_HOLDOUT_UNKNOWN:
        raise ValueError(f"max-files-per-class must be at least {MIN_HOLDOUT_UNKNOWN}.")
    if not KWS_ENGINE.status().get("open_set_ready"):
        raise ValueError("Shared KWS model is not ready. Check enrollment before testing.")
    if any(p not in PROFILES for p in profiles):
        raise ValueError("Only off, standard, strong and maximum profiles are supported.")

    inputs: dict[str, list[tuple[str, bytes]]] = {}
    sufficient = True
    for keyword in (*DEFAULT_KEYWORDS, NEGATIVE_CLASS):
        files = sorted((holdout / keyword).glob("*.wav"))
        minimum = MIN_HOLDOUT_UNKNOWN if keyword == NEGATIVE_CLASS else MIN_HOLDOUT_WORD
        if len(files) < minimum:
            sufficient = False
        inputs[keyword] = [(p.name, read_pcm_wav(p)) for p in files[:max_files]]
        for name, pcm in inputs[keyword]:
            duration = len(pcm) / (2 * SAMPLE_RATE)
            if not 0.30 <= duration <= 2.50:
                raise ValueError(f"{name}: holdout utterances must last 0.30-2.50 seconds.")

    comparison: dict[str, dict] = {}
    for snr in snrs:
        level: dict[str, dict] = {}
        for profile in profiles:
            level[profile] = {
                "positive_correct": 0, "positive_total": 0,
                "unknown_false_accepts": 0, "unknown_total": 0,
                "by_keyword": {},
            }
        for keyword, files in inputs.items():
            for profile in profiles:
                level[profile]["by_keyword"][keyword] = {
                    "correct": 0, "total": 0, "rejected": 0,
                    "wrong_keyword": 0, "predictions": {},
                }
            for index, (_, clip) in enumerate(files):
                mixed, start, end = mix_at_snr(
                    clip, noise_pcm, snr,
                    seed=seed + index * 911 + list(inputs).index(keyword) * 100_003,
                )
                for profile in profiles:
                    processed = mixed if profile == "off" else apply_profile(ffmpeg, mixed, profile)
                    # Both methods receive the same speech window and room
                    # noise mix. FFmpeg may change PCM clock by a few samples.
                    values = processed[start * 2:min(end * 2, len(processed))]
                    prediction, _ = predicted_word(values)
                    expected = None if keyword == NEGATIVE_CLASS else keyword
                    correct = prediction == expected
                    record = level[profile]
                    by_class = record["by_keyword"][keyword]
                    by_class["total"] += 1
                    by_class["correct"] += int(correct)
                    outcome = prediction if prediction is not None else "rejected"
                    by_class["predictions"][outcome] = by_class["predictions"].get(outcome, 0) + 1
                    if prediction is None:
                        by_class["rejected"] += 1
                    elif prediction != expected:
                        by_class["wrong_keyword"] += 1
                    if keyword == NEGATIVE_CLASS:
                        record["unknown_total"] += 1
                        record["unknown_false_accepts"] += int(prediction is not None)
                    else:
                        record["positive_total"] += 1
                        record["positive_correct"] += int(correct)
        for profile in profiles:
            record = level[profile]
            pos = record["positive_total"]
            neg = record["unknown_total"]
            record["keyword_recall"] = round(record["positive_correct"] / pos, 4) if pos else None
            record["unknown_false_accept_rate"] = round(record["unknown_false_accepts"] / neg, 4) if neg else None
        comparison[f"{snr:g}dB"] = level

    return {
        "experimental": True,
        "production_proven": False,
        "same_frozen_templates": True,
        "snr_definition": "RMS speech / RMS added recorded noise within each clip",
        "mode_notes": "off=raw 16-kHz PCM; standard/strong/maximum=FFmpeg filters (with 1s warmup); maximum uses afftdn nr=97 dB filter ceiling and may remove speech",
        "confusion_notes": "by_keyword.predictions counts every emitted word or rejected result, including HELP vs AMBULANCE confusions",
        "limits": "Pre-segmented offline KWS only; live CCTV VAD, ASR verification and alert delivery are NOT measured.",
        "heldout_counts": {key: len(value) for key, value in inputs.items()},
        "adequate_sample_counts": sufficient,
        "snr_results": comparison,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Compare frozen KWS templates across recorded-noise SNR conditions.")
    parser.add_argument("--holdout", type=Path, required=True,
                        help="Folder containing help/fire/.../unknown PCM16 16-kHz WAV files (never enrolled).")
    parser.add_argument("--noise-only", type=Path, required=True,
                        help="At least 2 seconds of consented room-noise WAV, no speech.")
    parser.add_argument("--snrs", type=float, nargs="+", default=list(LEVELS))
    parser.add_argument("--profiles", nargs="+", choices=PROFILES, default=list(PROFILES))
    parser.add_argument("--max-files-per-class", type=int, default=10)
    parser.add_argument("--seed", type=int, default=2026)
    args = parser.parse_args()

    try:
        need_ffmpeg = any(p != "off" for p in args.profiles)
        ffmpeg = resolve_exe("ffmpeg", "FFMPEG_EXE") if need_ffmpeg else ""
        if need_ffmpeg and not ffmpeg:
            raise RuntimeError("FFmpeg not found; install local-server/bin/ffmpeg.exe or add it to PATH.")
        noise = read_pcm_wav(args.noise_only)
        result = compare(ffmpeg, args.holdout, noise, tuple(args.snrs),
                         tuple(dict.fromkeys(args.profiles)), args.max_files_per_class, args.seed)
        print(json.dumps(result, indent=2))
        return 0
    except (RuntimeError, OSError, ValueError) as exc:
        print(json.dumps({"experimental": True, "error": str(exc)}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
