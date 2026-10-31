"""Label-blind speech-candidate localization for *offline* MSDS V4 research.

Uses amplitude contrast and local modulation only. This is not a validated
voice activity detector: background media, impacts and other noises may win.
Never use this module to trigger operational safety alerts.
"""
from __future__ import annotations

import numpy as np

SAMPLE_RATE = 16000
MAX_CROP_SECONDS = 1.60
MIN_CROP_SECONDS = 0.60


def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    padded = np.r_[False, mask.astype(bool), False]
    changes = np.diff(padded.astype(np.int8))
    starts = np.flatnonzero(changes == 1)
    ends = np.flatnonzero(changes == -1)
    return list(zip(map(int, starts), map(int, ends)))


def localize_speech_candidate(
    samples: np.ndarray,
    *,
    sample_rate: int = SAMPLE_RATE,
    max_seconds: float = MAX_CROP_SECONDS,
    min_seconds: float = MIN_CROP_SECONDS,
) -> tuple[np.ndarray, dict]:
    """Return one deterministic, waveform-only crop and its diagnostic metadata.

    The expected word and the classifier never influence crop selection.
    Relative-frame energy contrast finds speech-like regions; short gaps are
    merged. A long active region is capped using energy modulation, rather
    than choosing a crop based on the trained model's confidence.
    """
    signal = np.asarray(samples, dtype=np.float32)
    if signal.ndim != 1 or signal.size == 0 or not np.isfinite(signal).all():
        raise ValueError("Expected nonempty, finite mono PCM")
    if sample_rate <= 0 or not 0.35 <= min_seconds <= max_seconds <= 4.0:
        raise ValueError("Invalid sample rate or crop duration")
    total = signal.size
    cap = min(total, max(1, round(max_seconds * sample_rate)))
    minimum = min(total, max(1, round(min_seconds * sample_rate)))
    if total <= minimum:
        return signal.copy(), {
            "start_s": 0.0, "end_s": round(total / sample_rate, 4),
            "reason": "short_original", "duration_s": round(total / sample_rate, 4),
            "active_duration_s": round(total / sample_rate, 4),
        }

    frame = max(1, round(0.025 * sample_rate))
    hop = max(1, round(0.010 * sample_rate))
    if total < frame:
        return signal.copy(), {
            "start_s": 0.0, "end_s": round(total / sample_rate, 4),
            "reason": "short_original", "duration_s": round(total / sample_rate, 4),
            "active_duration_s": round(total / sample_rate, 4),
        }
    starts = np.arange(0, total - frame + 1, hop, dtype=np.int64)
    squares = np.asarray(signal, dtype=np.float64) ** 2
    prefix = np.r_[0.0, np.cumsum(squares)]
    rms = np.sqrt(np.maximum(
        (prefix[starts + frame] - prefix[starts]) / frame, 0.0
    ))
    low = float(np.percentile(rms, 20))
    high = float(np.percentile(rms, 90))
    threshold = max(0.007, low + max(0.005, 0.25 * max(high - low, 0.0)))
    active = rms >= threshold

    # Merge quiet gaps <=70ms between speech-like energy regions.
    max_gap_frames = max(1, round(0.070 * sample_rate / hop))
    runs = _runs(active)
    for (_, end), (next_start, _) in zip(runs, runs[1:]):
        if next_start - end <= max_gap_frames:
            active[end:next_start] = True

    candidate_runs = [
        (a, b) for a, b in _runs(active)
        if (b - a) * hop / sample_rate >= 0.075
    ]
    if candidate_runs:
        # Deterministic, label-blind scoring. Contrast above the low-energy
        # baseline suppresses a constant hum but not a changing TV voice.
        a, b = max(
            candidate_runs,
            key=lambda pair: (
                float(np.maximum(rms[pair[0]:pair[1]] - low, 0.0).sum()),
                pair[1] - pair[0], -pair[0],
            ),
        )
        left = max(0, int(starts[a]) - round(0.10 * sample_rate))
        right = min(total, int(starts[b - 1]) + frame + round(0.10 * sample_rate))
        reason = "contrast_energy"
    else:
        left, right = 0, total
        reason = "no_contrast_fallback"

    # Enforce a minimum context window, centered on the candidate region.
    desired = max(minimum, right - left)
    if desired > cap:
        desired = cap
    if right - left < desired:
        center = (left + right) // 2
        left = min(max(0, center - desired // 2), total - desired)
        right = left + desired

    if right - left > cap:
        # Use *only* acoustic contrast and envelope modulation to choose
        # among windows inside the long active region. No class probabilities.
        width_frames = max(1, round(cap / hop))
        a0 = max(0, (left - frame) // hop)
        b0 = min(len(rms), (right + frame) // hop + 1)
        energy = np.maximum(rms - low, 0.0)
        transitions = np.r_[0.0, np.abs(np.diff(rms))]
        # Both terms measured in amplitude; fast changes help to avoid
        # selecting a long, stationary ambient-noise plateau.
        score = energy + 0.75 * transitions
        positions = np.arange(a0, max(a0 + 1, b0 - width_frames + 1))
        prefix_score = np.r_[0.0, np.cumsum(score)]
        clipped_ends = np.minimum(positions + width_frames, len(score))
        values = prefix_score[clipped_ends] - prefix_score[positions]
        best = int(positions[int(np.argmax(values))])
        center = int(starts[min(best, len(starts) - 1)]) + cap // 2
        left = min(max(0, center - cap // 2), total - cap)
        right = left + cap
        reason += "_capped"
    if right <= left:
        raise ValueError("Audio localization failed to produce a valid segment")

    return signal[left:right].copy(), {
        "start_s": round(left / sample_rate, 4),
        "end_s": round(right / sample_rate, 4),
        "duration_s": round((right - left) / sample_rate, 4),
        "active_duration_s": round(float(np.count_nonzero(active) * hop / sample_rate), 4),
        "rms_noise_reference": round(low, 6),
        "rms_active_threshold": round(threshold, 6),
        "reason": reason,
    }


def temporal_logmel(samples: np.ndarray, extractor, *, steps: int = 48) -> np.ndarray:
    """Resample the *ordered* acoustic sequence, preserving 32 Mel channels.

    The existing feature-only engine supplies Log-Mel frames; no enrollment
    store is read. V4 uses a trainable temporal convolution over these frames
    rather than feeding a flattened 16-step vector to an MLP.
    """
    if steps < 20 or steps > 128:
        raise ValueError("Expected 20..128 temporal steps")
    pcm = (np.clip(samples, -1.0, 0.999969) * 32767).astype("<i2").tobytes()
    sequence = extractor.extract_features(pcm)
    if sequence.ndim != 2 or sequence.shape[1] != 32 or len(sequence) < 12:
        raise ValueError("No valid speech-like Log-Mel frames for V4 sequence")
    locations = np.linspace(0, len(sequence) - 1, steps, dtype=np.float32)
    lo = np.floor(locations).astype(int)
    hi = np.minimum(lo + 1, len(sequence) - 1)
    alpha = (locations - lo)[:, None]
    resampled = sequence[lo] * (1 - alpha) + sequence[hi] * alpha
    return np.asarray(resampled, dtype=np.float32)
