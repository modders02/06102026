"""Opt-in DeepFilterNet + sherpa-onnx English KWS experiment.

Never trains/rewrites DTW enrollment, changes thresholds, or publishes alerts.
Use MSDS_KWS_NEURAL_MODE=shadow to compare independently to the DTW decision.
Verification mode (after validation) requires BOTH engines to agree.
All imports/model downloads are lazy; default 'off' needs no neural packages.
"""
from __future__ import annotations

import os
import re
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .kws_engine import DEFAULT_KEYWORDS, SAMPLE_RATE

MODEL_NAME = "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01"
MODEL_ROOT = Path(__file__).resolve().parents[1] / "models" / MODEL_NAME
_ALLOWED = frozenset(DEFAULT_KEYWORDS)
_MUTEX = threading.RLock()
_SPOTTER = None
_DF = None


def neural_mode() -> str:
    value = os.environ.get("MSDS_KWS_NEURAL_MODE", "off").strip().lower()
    return value if value in ("off", "shadow", "verify") else "off"


def model_directory() -> Path:
    value = os.environ.get("MSDS_SHERPA_KWS_MODEL_DIR", "").strip()
    return Path(value).expanduser() if value else MODEL_ROOT


@dataclass(frozen=True)
class NeuralObservation:
    keyword: str
    processing_ms: float
    enhanced: bool
    error: str = ""


def _load_spotter():
    global _SPOTTER
    if _SPOTTER is not None:
        return _SPOTTER
    import sherpa_onnx
    folder = model_directory()
    prefix = "epoch-12-avg-2-chunk-16-left-64"
    files = {
        "tokens": folder / "tokens.txt",
        "encoder": folder / f"encoder-{prefix}.int8.onnx",
        "decoder": folder / f"decoder-{prefix}.onnx",
        "joiner": folder / f"joiner-{prefix}.int8.onnx",
        "keywords_file": folder / "msds_keywords.txt",
    }
    missing = [name for name, p in files.items() if not p.is_file()]
    if missing:
        raise RuntimeError(f"Sherpa English model incomplete ({', '.join(missing)}); run setup-neural-kws.ps1")
    _SPOTTER = sherpa_onnx.KeywordSpotter(
        **{name: str(path) for name, path in files.items()},
        provider="cpu", num_threads=2,
        keywords_score=1.0, keywords_threshold=0.35,
    )
    return _SPOTTER


def _df_model_and_state(loaded: tuple):
    """Support both historical and current init_df return signatures."""
    if not isinstance(loaded, tuple) or len(loaded) < 2:
        raise RuntimeError("DeepFilterNet initialization did not return model and state")
    return loaded[0], loaded[1]


def neural_attenuation_limit_db() -> float | None:
    """Maximum means UNLIMITED model suppression, not an invented dB target.

    DeepFilterNet's enhance(atten_lim_db=None) applies the complete neural
    mask without mixing back a fixed amount of the original noisy signal.
    Positive limits retain increasing amounts of background audio.
    """
    strength = os.environ.get("MSDS_KWS_NEURAL_STRENGTH", "maximum").strip().lower()
    return {"balanced": 12.0, "strong": 24.0, "maximum": None}.get(strength, None)


def _enhance_16k(audio: np.ndarray) -> np.ndarray:
    """DeepFilterNet is 48k; preserve sample length via band-limited resampling."""
    global _DF
    from scipy.signal import resample_poly
    import torch
    from df.enhance import init_df, enhance
    if _DF is None:
        _DF = init_df(model_base_dir="DeepFilterNet3")
    # DeepFilterNet's init_df returns (model, df_state, suffix, epoch)
    # in current releases; handle older three-value returns as well.
    model, state = _df_model_and_state(_DF)
    source_rate = int(state.sr())
    if source_rate != 48000:
        raise RuntimeError(f"Unexpected DeepFilterNet sample rate {source_rate}")
    hi = resample_poly(audio, 3, 1).astype(np.float32, copy=False)
    # Every word is an independent VAD segment. Reset the DSP state so a
    # preceding word/camera cannot bleed into the current word.
    if hasattr(state, "reset"):
        state.reset()
    with torch.inference_mode():
        cleaned = enhance(
            model, state, torch.from_numpy(hi.copy())[None, :],
            atten_lim_db=neural_attenuation_limit_db(),
        )
    samples = cleaned.detach().cpu().numpy().reshape(-1)
    down = resample_poly(samples, 1, 3).astype(np.float32, copy=False)
    if not np.all(np.isfinite(down)):
        raise RuntimeError("DeepFilterNet produced non-finite audio")
    if len(down) < len(audio):
        down = np.pad(down, (0, len(audio) - len(down)))
    return np.clip(down[:len(audio)], -1.0, 1.0)


def detect_keyword(pcm16: bytes) -> NeuralObservation:
    """Run one already segmented keyword through neural enhancement + KWS.

    Models are shared and serialized between cameras. This is a deliberately
    conservative experimental path, not a guaranteed real-time inference SLA.
    """
    start = time.perf_counter()
    if len(pcm16) < int(0.30 * SAMPLE_RATE * 2) or len(pcm16) % 2:
        return NeuralObservation("", 0.0, False, "invalid_segment")
    try:
        with _MUTEX:
            audio = np.frombuffer(pcm16, dtype="<i2").astype(np.float32) / 32768.0
            if os.environ.get("MSDS_KWS_NEURAL_DENOISE", "1").strip().lower() not in ("0", "false", "off"):
                audio = _enhance_16k(audio)
                enhanced = True
            else:
                enhanced = False
            spotter = _load_spotter()
            stream = spotter.create_stream()
            stream.accept_waveform(SAMPLE_RATE, audio)
            stream.accept_waveform(SAMPLE_RATE, np.zeros(int(0.75 * SAMPLE_RATE), np.float32))
            stream.input_finished()
            for _ in range(250):
                if not spotter.is_ready(stream):
                    break
                spotter.decode_stream(stream)
                value = spotter.get_result(stream)
                if value:
                    # Only an EXACT configured English word may be considered
                    # corroboration. Do not substring-match arbitrary sentences.
                    key = re.sub(r"[^a-z]", "", str(value).lower())
                    return NeuralObservation(
                        key if key in _ALLOWED else "",
                        round((time.perf_counter() - start) * 1000, 2), enhanced,
                    )
            return NeuralObservation("", round((time.perf_counter() - start) * 1000, 2), enhanced)
    except Exception as exc:
        return NeuralObservation(
            "", round((time.perf_counter() - start) * 1000, 2),
            False, f"{type(exc).__name__}: {exc}"[:320],
        )
