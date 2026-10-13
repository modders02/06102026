"""Optional, fail-closed second-stage ASR verification for CCTV keyword spotting.

This module is lightweight to import. Faster-Whisper and its model are only
loaded when MSDS_KWS_VERIFY_ASR=1 and an eligible KWS candidate arrives.
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


def help_rescue_enabled() -> bool:
    """Independent opt-in; normal KWS and ASR behavior is unchanged by default."""
    return enabled() and os.environ.get(
        "MSDS_KWS_HELP_RESCUE", "0"
    ).strip().lower() in ("1", "true", "yes", "on")


@dataclass(frozen=True)
class HelpRescueTarget:
    """Constrained ASR review target, not a KWS acceptance decision."""

    keyword: str
    confidence: float
    source: str


def help_rescue_target(decision) -> HelpRescueTarget | None:
    """Offer a second opinion for strongly evidenced HELP/AMBULANCE confusion.

    Global MATCH_THRESHOLD, OPEN_SET_MARGIN and per-class margins remain
    untouched. This opt-in path cannot create an event without independent ASR
    returning the isolated word HELP. The frontend still requires facial
    distress evidence before treating HELP as a multimodal distress alert.

    KWS may rank AMBULANCE first for actual HELP (measured in template LOO
    audit), so a strict top-1 HELP requirement misses that case entirely.
    We allow a very close second-place HELP ONLY when the first-place
    AMBULANCE candidate was itself rejected by KWS.
    """
    if not help_rescue_enabled() or not decision or decision.accepted:
        return None

    reason = decision.reason
    if decision.keyword == "help":
        if reason not in ("too_close_to_unknown", "insufficient_margin"):
            return None
        if decision.runner_up_keyword != "ambulance":
            return None
        if decision.confidence < 0.88:
            return None
        if not 0.75 <= decision.duration_ratio <= 1.30:
            return None
        # Confirm there is some evidence of HELP over both UNKNOWN and the
        # next-closest positive class; Whisper is not a substitute for KWS.
        if decision.class_margin < 0.012:
            return None
        if decision.confidence - decision.negative_confidence < 0.020:
            return None
        return HelpRescueTarget("help", decision.confidence, "primary")

    if decision.keyword == "ambulance" and decision.runner_up_keyword == "help":
        if reason not in (
            "too_close_to_unknown", "insufficient_margin", "duration_mismatch"
        ):
            return None
        scores = getattr(decision, "keyword_scores", {}) or {}
        ratios = getattr(decision, "keyword_duration_ratios", {}) or {}
        help_score = float(scores.get("help", decision.runner_up_confidence))
        help_ratio = float(ratios.get("help", 0.0))
        if help_score < 0.90:
            return None
        # HELP must be almost tied with the leading AMBULANCE class.
        if decision.confidence - help_score > 0.025:
            return None
        # Unlike AMBULANCE, HELP must have a normal target duration.
        if not 0.75 <= help_ratio <= 1.30:
            return None
        # Preserve a tight boundary: UNKNOWN may narrowly win, but a large
        # UNKNOWN lead is not eligible even if the ASR guesses HELP.
        if help_score - decision.negative_confidence < -0.015:
            return None
        return HelpRescueTarget("help", help_score, "runner_up")

    return None


def eligible_help_rescue(decision) -> bool:
    """Compatibility/diagnostic boolean used by the original HELP tests."""
    return help_rescue_target(decision) is not None


def isolated_help(transcript: str) -> bool:
    """Rescue requires ASR to hear only HELP, not incidental mentions in speech."""
    return re.findall(r"[a-z0-9]+", transcript.lower()) == ["help"]


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
