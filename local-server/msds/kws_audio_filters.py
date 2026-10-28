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


# Speech-specific RNNoise model; NEVER overwrite the original DTW templates.
# The official FFmpeg arnndn filter requires a separately downloaded .rnnn
# model. The installer fetches a pinned community model into this folder.
RNNOISE_MODEL_FILE = "sh.rnnn"
RNNOISE_RELATIVE_DIR = os.path.join("models", "rnnoise")


def voice_isolation_mode() -> str:
    """Optional voice-focused RNN denoising; stable default remains OFF.

    Maximum uses 100% neural-filtered audio; balanced blends 75% enhanced
    speech with 25% original, which can preserve quieter consonants.
    Neither preset guarantees complete silence around every voice.
    """
    value = os.environ.get("MSDS_KWS_VOICE_ISOLATION", "off").strip().lower()
    return value if value in ("off", "balanced", "maximum") else "off"


def voice_isolation_model_dir() -> str:
    """Absolute model working directory; eliminates Windows FFmpeg ':' escaping."""
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.abspath(
        os.environ.get("MSDS_RNNOISE_MODEL_DIR")
        or os.path.join(base, RNNOISE_RELATIVE_DIR)
    )


def voice_isolation_model_path() -> str:
    return os.path.join(voice_isolation_model_dir(), RNNOISE_MODEL_FILE)


def denoise_enabled() -> bool:
    return os.environ.get("MSDS_KWS_AUDIO_DENOISE", "0").strip().lower() in (
        "1", "true", "yes", "on"
    )


def selected_profile() -> str:
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
    voice = voice_isolation_mode()
    if voice != "off":
        # RNNoise expects 48-kHz audio. Convert before RNN filtering, then
        # return to the EXACT original DTW engine's 16-kHz mono PCM format.
        # sh.rnnn is resolved from FFmpeg's working directory, so Windows
        # paths such as C:\\Users\\... never need filtergraph escaping.
        mix = "1" if voice == "maximum" else "0.75"
        filters.extend(["highpass=f=80", "aresample=48000",
                        f"arnndn=m={RNNOISE_MODEL_FILE}:mix={mix}"])
        # Do not stack the 97-dB FFT filter on top of RNNoise; double noise
        # suppression can erase quiet/short English emergency words.
    elif enabled:
        filters.extend(["highpass=f=120", "lowpass=f=4200", PROFILES[profile]])
    filters.extend(["aresample=16000:async=1:first_pts=0", "asetpts=N/SR/TB"])
    return ",".join(filters)
