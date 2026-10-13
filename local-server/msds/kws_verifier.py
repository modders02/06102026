"""Optional, fail-closed second-stage ASR verification for CCTV keyword spotting.

This module is lightweight to import. Faster-Whisper and its model are only
loaded when MSDS_KWS_VERIFY_ASR=1 and an accepted KWS candidate arrives.
"""
from __future__ import annotations

import os
import re
import tempfile
import threading
import wave
from dataclasses import dataclass
from pathlib import Path

# One shared CPU model; serialize decoding when multiple cameras are active.
_MODEL = None
_MODEL_NAME = None
_MODEL_LOCK = threading.RLock()


@dataclass(frozen=True)
class Verification:
    accepted: bool
    state: str
    transcript: str = ""
    error: str = ""


def enabled() -> bool:
    return os.environ.get("MSDS_KWS_VERIFY_ASR", "0").strip().lower() in (
        "1", "true", "yes", "on",
    )


def model_name() -> str:
    # English speech only on this research branch. Download on first use.
    return os.environ.get("MSDS_KWS_VERIFY_MODEL", "base.en").strip() or "base.en"


def _get_model():
    global _MODEL, _MODEL_NAME
    chosen = model_name()
    if _MODEL is None or chosen != _MODEL_NAME:
        from faster_whisper import WhisperModel
        _MODEL = WhisperModel(chosen, device="cpu", compute_type="int8")
        _MODEL_NAME = chosen
    return _MODEL


def _word_match(transcript: str, keyword: str) -> bool:
    """Whole-token comparison; 'fine' never matches 'fire'."""
    words = re.findall(r"[a-z0-9]+", transcript.lower())
    target = re.findall(r"[a-z0-9]+", keyword.replace("_", " ").lower())
    return bool(target) and any(
        words[i:i + len(target)] == target
        for i in range(len(words) - len(target) + 1)
    )


def verify_kws_segment(pcm: bytes, keyword: str) -> Verification:
    """Verify an already-accepted KWS result using the SAME speech segment.

    Missing model, uncertain ASR, mismatch or decode error all reject the
    candidate. Do not interpret agreement as a deployment safety guarantee.
    """
    # At least 0.2 s of 16 kHz mono 16-bit audio; WAV frames must be complete.
    if len(pcm) < 6400 or len(pcm) % 2 != 0:
        return Verification(False, "verification_invalid_audio")

    try:
        with tempfile.TemporaryDirectory(prefix="msds-kws-verify-") as directory:
            wav_path = Path(directory) / "segment.wav"
            with wave.open(str(wav_path), "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(16000)
                wav.writeframes(pcm)

            with _MODEL_LOCK:
                model = _get_model()
                # Segmenter already did VAD. Another VAD pass may erase short
                # emergency utterances, so pass the whole segment to ASR.
                segments, _ = model.transcribe(
                    str(wav_path),
                    language="en",
                    task="transcribe",
                    vad_filter=False,
                    condition_on_previous_text=False,
                    beam_size=5,
                    temperature=0.0,
                    no_speech_threshold=0.6,
                    log_prob_threshold=-1.0,
                )
                words = []
                for segment in segments:
                    if getattr(segment, "no_speech_prob", 0.0) > 0.6:
                        continue
                    if getattr(segment, "avg_logprob", 0.0) < -1.0:
                        continue
                    words.append((segment.text or "").strip())
                transcript = " ".join(words).strip()
    except Exception as exc:
        return Verification(False, "verification_unavailable", error=str(exc)[:250])

    if not transcript:
        return Verification(False, "verification_no_speech")
    if not _word_match(transcript, keyword):
        return Verification(False, "verification_mismatch", transcript=transcript)
    return Verification(True, "verified", transcript=transcript)
