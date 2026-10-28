"""Central KWS-only FFmpeg audio processing profiles.

The 80% target is a *measured noise power reduction* on a separate noise-only
recording, not a claim about speech recognition accuracy or arbitrary noise.
Leave denoising opt-in to preserve compatibility with existing KWS templates.
"""
from __future__ import annotations

import os

PROFILES = {
    # Backward-compatible from fix/kws-noisy-speech-vad-denoise.
    "standard": "afftdn=nr=12:nf=-40:tn=1",
    # Candidate for stationary room noise (~ -30 dBFS in prior CCTV logs).
    # Must be validated against recorded speech: stronger is not always better.
    "strong": "afftdn=nr=24:nf=-30:tn=1",
}


def robust_mode() -> str:
    """Experimental bundled preset. Off preserves the stable engine defaults.

    A single flag selects the existing FFmpeg spectral filter and requests
    WebRTC VAD; neither changes stored enrollment templates or thresholds.
    """
    value = os.environ.get("MSDS_KWS_ROBUST_MODE", "off").strip().lower()
    return value if value in ("off", "standard", "strong") else "off"


def webrtc_requested() -> bool:
    return robust_mode() != "off" or os.environ.get(
        "MSDS_KWS_WEBRTC_VAD", "0"
    ).strip().lower() in ("1", "true", "yes", "on")


def denoise_enabled() -> bool:
    return robust_mode() != "off" or os.environ.get(
        "MSDS_KWS_AUDIO_DENOISE", "0"
    ).strip().lower() in ("1", "true", "yes", "on")


def selected_profile() -> str:
    mode = robust_mode()
    if mode != "off":
        return mode
    value = os.environ.get("MSDS_KWS_NOISE_PROFILE", "standard").strip().lower()
    if value not in PROFILES:
        # Invalid configuration fails safely to the established profile.
        return "standard"
    return value


def pcm_audio_filter(*, enabled: bool | None = None, profile: str | None = None) -> str:
    """Identical live/offline filter chain, ending in a 16 kHz PCM clock."""
    if enabled is None:
        enabled = denoise_enabled()
    if profile is None:
        profile = selected_profile()
    if profile not in PROFILES:
        raise ValueError(f"Unknown noise profile: {profile}")
    filters = []
    if enabled:
        filters.extend(["highpass=f=120", "lowpass=f=4200", PROFILES[profile]])
    filters.extend(["aresample=16000:async=1:first_pts=0", "asetpts=N/SR/TB"])
    return ",".join(filters)
