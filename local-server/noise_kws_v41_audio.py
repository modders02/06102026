"""Research-only V4.1 preprocessing: preserve context around label-blind V4 crop.

The fixed +/-0.55 s margin is applied uniformly to every training,
augmented and session-validation recording, including UNKNOWN and noise.
It was suggested by HUMAN inspection of an already-used development
validation set. It MUST NOT be presented as independent validation.

No label-conditional processing, prediction-confidence search, deployment,
enrollment-store access, or mutation of original WAVs.
"""
from __future__ import annotations

import numpy as np

from noise_kws_v4_audio import localize_speech_candidate, temporal_logmel
from audit_noise_kws_v4_context import expand_crop_bounds, PADDING_SECONDS


def context_preserving_feature(samples: np.ndarray, extractor):
    """Return (48x32 features, crop metadata) for uniform fixed context."""
    signal = np.asarray(samples, dtype=np.float32)
    # The V4 localizer uses acoustic evidence only, never the true label.
    _, original = localize_speech_candidate(signal)
    cropped, expanded = expand_crop_bounds(
        signal, original["start_s"], original["end_s"],
        padding_seconds=PADDING_SECONDS,
    )
    feature = temporal_logmel(cropped, extractor)
    if feature.shape != (48, 32) or not np.isfinite(feature).all():
        raise ValueError("Invalid context-preserved temporal features")
    return feature, {
        "start_s": expanded["start_s"],
        "end_s": expanded["end_s"],
        "duration_s": expanded["duration_s"],
        "reason": "v4_baseline_plus_fixed_context",
        "baseline_start_s": original["start_s"],
        "baseline_end_s": original["end_s"],
        "baseline_reason": original["reason"],
        "context_seconds_per_side": PADDING_SECONDS,
    }
