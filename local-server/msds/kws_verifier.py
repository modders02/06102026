"""Optional, fail-closed second-stage ASR verification for CCTV keyword spotting.

This module is lightweight to import. Faster-Whisper and its model are only
loaded when MSDS_KWS_VERIFY_ASR=1 and an eligible KWS candidate arrives.
"""
from __future__ import annotations

import math
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

# Keep at most one decode/model download in flight across all CCTV cameras.
# A timed-out worker is deliberately NOT killed: force-killing threads during
# CTranslate2/Hugging Face downloads is unsafe. Instead, its late result is
# ignored and new calls fail closed until it returns.
_VERIFICATION_STATE_LOCK = threading.Lock()
_VERIFICATION_WORKER: threading.Thread | None = None


@dataclass(frozen=True)
class Verification:
    accepted: bool
    state: str
    transcript: str = ""
    error: str = ""
    raw_transcript: str = ""
    no_speech_prob: float | None = None
    avg_logprob: float | None = None


def enabled() -> bool:
    return os.environ.get("MSDS_KWS_VERIFY_ASR", "0").strip().lower() in (
        "1", "true", "yes", "on",
    )


HELP_FAST_ACCEPT_THRESHOLD = 0.90


def help_fast_accept_enabled() -> bool:
    """Explicit opt-in for KWS-only HELP recognition at 90% (not dispatch)."""
    return os.environ.get(
        "MSDS_KWS_HELP_90_FAST_ACCEPT", "0"
    ).strip().lower() in ("1", "true", "yes", "on")


def eligible_help_fast_accept(decision) -> bool:
    """HELP-only recognition shortcut; never trust 90% similarity alone.

    Permit top-ranked HELP with >=90% template similarity without waiting for
    Whisper, even if the normal 3% UNKNOWN or calibrated class gap is too
    narrow. Preserve training readiness, credible duration, and require HELP
    to *beat* UNKNOWN (not merely score above 90%).
    Emergency alerts still need separate multimodal validation.
    """
    if not help_fast_accept_enabled() or not decision:
        return False
    if decision.keyword != "help" or decision.confidence < HELP_FAST_ACCEPT_THRESHOLD:
        return False
    if decision.reason not in ("accepted", "too_close_to_unknown", "insufficient_margin"):
        return False
    if not (0.60 <= decision.duration_ratio <= 1.55):
        return False
    if decision.negative_confidence >= decision.confidence:
        return False
    return True


def short_help_review_enabled() -> bool:
    """Opt-in: inspect short HELP speech that Whisper marks as silence."""
    return help_rescue_enabled() and os.environ.get(
        "MSDS_KWS_SHORT_HELP_ASR", "0"
    ).strip().lower() in ("1", "true", "yes", "on")


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


def eligible_fire_help_disagreement(decision) -> bool:
    """Strict, opt-in cross-keyword review for accepted FIRE with HELP second.

    This does *not* override a verified FIRE: the existing ASR first checks
    FIRE normally. Only a FIRE/HELP ASR disagreement with an isolated HELP
    transcript can be reinterpreted, using independent HELP KWS evidence.
    All values are experimental, based on controlled diagnostics, and require
    negative-speech and live CCTV validation before dispatch.
    """
    if not help_rescue_enabled() or not decision:
        return False
    if not decision.accepted or decision.keyword != "fire":
        return False
    if decision.reason != "accepted" or decision.runner_up_keyword != "help":
        return False

    scores = getattr(decision, "keyword_scores", {}) or {}
    ratios = getattr(decision, "keyword_duration_ratios", {}) or {}
    if "help" not in scores or "help" not in ratios:
        return False
    try:
        help_score = float(scores["help"])
        help_ratio = float(ratios["help"])
        fire_score = float(decision.confidence)
        unknown_score = float(decision.negative_confidence)
    except (TypeError, ValueError, OverflowError):
        return False

    if not (0.80 <= help_score <= fire_score <= 0.90):
        return False
    if not (0 <= fire_score - help_score <= 0.060):
        return False
    if not (0.75 <= help_ratio <= 1.30):
        return False
    if not (-0.015 <= help_score - unknown_score <= 0.10):
        return False
    return True


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


def _verify_kws_segment_direct(pcm: bytes, keyword: str) -> Verification:
    """Verify an already-accepted KWS result using the SAME speech segment.

    Missing model, uncertain ASR, mismatch or decode error all reject the
    candidate. Do not interpret agreement as a deployment safety guarantee.
    """
    # At least 0.2 s of 16 kHz mono 16-bit audio; WAV frames must be complete.
    if len(pcm) < 6400 or len(pcm) % 2 != 0:
        return Verification(False, "verification_invalid_audio")

    # The original verifier discards every segment with
    # no_speech_prob > 0.6 even if the decoded word has strong log probability.
    # This is particularly problematic for short, VAD-trimmed one-word HELP.
    # Opt-in review disables the decoder's early no-speech suppression ONLY
    # for short HELP, then applies a strict post-decode quality check.
    short_help = (
        keyword == "help" and short_help_review_enabled()
        and len(pcm) <= int(0.80 * 16000 * 2)
    )
    raw_words: list[str] = []
    accepted_words: list[str] = []
    max_no_speech: float | None = None
    min_logprob: float | None = None
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
                segments, _ = model.transcribe(
                    str(wav_path),
                    language="en",
                    task="transcribe",
                    vad_filter=False,
                    condition_on_previous_text=False,
                    beam_size=5,
                    temperature=0.0,
                    # VAD has already found speech. Avoid discarding a
                    # confident short HELP token before we can inspect it.
                    no_speech_threshold=None if short_help else 0.6,
                    log_prob_threshold=-1.0,
                )
                # Consume the generator while the lock and temp WAV exist.
                for segment in segments:
                    raw_text = (getattr(segment, "text", "") or "").strip()
                    probability = float(getattr(segment, "no_speech_prob", 0.0))
                    logprob = float(getattr(segment, "avg_logprob", 0.0))
                    max_no_speech = (
                        probability if max_no_speech is None
                        else max(probability, max_no_speech)
                    )
                    min_logprob = (
                        logprob if min_logprob is None
                        else min(logprob, min_logprob)
                    )
                    if raw_text:
                        raw_words.append(raw_text)
                    if not raw_text:
                        continue
                    if logprob < -1.0:
                        continue
                    if probability > 0.6:
                        # Strong decoding confidence is needed to override
                        # a high no-speech probability. Never accept weak
                        # hallucinations from silence.
                        if not short_help or logprob < -0.45:
                            continue
                    accepted_words.append(raw_text)
    except Exception as exc:
        return Verification(
            False, "verification_unavailable", error=str(exc)[:250],
            raw_transcript=" ".join(raw_words).strip(),
            no_speech_prob=max_no_speech, avg_logprob=min_logprob,
        )

    transcript = " ".join(accepted_words).strip()
    diagnostic = dict(
        raw_transcript=" ".join(raw_words).strip(),
        no_speech_prob=max_no_speech,
        avg_logprob=min_logprob,
    )
    if not transcript:
        return Verification(False, "verification_no_speech", **diagnostic)
    if not _word_match(transcript, keyword):
        return Verification(
            False, "verification_mismatch", transcript=transcript, **diagnostic
        )
    return Verification(True, "verified", transcript=transcript, **diagnostic)


def verification_timeout_seconds() -> float:
    """Bound first-use model downloads / CPU inference without hanging CCTV."""
    configured = os.environ.get("MSDS_KWS_VERIFY_TIMEOUT_SECONDS", "12")
    try:
        seconds = float(configured)
        if not math.isfinite(seconds):
            raise ValueError("nonfinite timeout")
    except ValueError:
        seconds = 12.0
    return max(2.0, min(60.0, seconds))


def verification_in_flight() -> bool:
    """Expose verifier occupancy for stalled-model diagnostics."""
    with _VERIFICATION_STATE_LOCK:
        return _VERIFICATION_WORKER is not None and _VERIFICATION_WORKER.is_alive()


def verify_kws_segment(pcm: bytes, keyword: str) -> Verification:
    """Time-bound, fail-closed verification.

    KWS calls this synchronously, so never leave the audio pipeline stuck on
    verification_pending when a model download or CPU decoder stalls. Only
    one daemon worker is allowed: a timed-out download cannot spawn an
    unbounded collection of threads or later publish a stale emergency event.
    """
    global _VERIFICATION_WORKER

    # Reject obviously bad audio without spawning work or acquiring model locks.
    if len(pcm) < 6400 or len(pcm) % 2:
        return Verification(False, "verification_invalid_audio")

    done = threading.Event()
    result: list[Verification] = []

    def worker() -> None:
        global _VERIFICATION_WORKER
        try:
            result.append(_verify_kws_segment_direct(pcm, keyword))
        except Exception as exc:
            result.append(
                Verification(False, "verification_unavailable", error=str(exc)[:250])
            )
        finally:
            # Clearing ownership before signaling completion allows the next
            # eligible word to use the now-idle ASR model immediately.
            with _VERIFICATION_STATE_LOCK:
                if _VERIFICATION_WORKER is threading.current_thread():
                    _VERIFICATION_WORKER = None
            done.set()

    with _VERIFICATION_STATE_LOCK:
        if _VERIFICATION_WORKER is not None and _VERIFICATION_WORKER.is_alive():
            return Verification(
                False, "verification_busy",
                error="Previous Whisper decode/model load is still running; no event published."
            )
        thread = threading.Thread(
            target=worker, name="msds-kws-asr-verifier", daemon=True
        )
        _VERIFICATION_WORKER = thread
        try:
            thread.start()
        except RuntimeError as exc:
            _VERIFICATION_WORKER = None
            return Verification(
                False, "verification_unavailable", error=str(exc)[:250]
            )

    timeout = verification_timeout_seconds()
    if not done.wait(timeout):
        return Verification(
            False, "verification_timeout",
            error=(
                f"Whisper did not return within {timeout:g}s. "
                "Model download or CPU inference may still be running; "
                "this keyword was rejected."
            ),
        )
    return result[0] if result else Verification(
        False, "verification_unavailable",
        error="Whisper verifier ended without a result."
    )
