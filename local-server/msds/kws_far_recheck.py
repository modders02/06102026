"""Conservative, opt-in far-field KWS recheck.

The far VAD retains 200 ms of pre-roll to avoid clipping quiet consonants.
When the original HELP candidate is very strong but fails *only* the
open-set/runner-up margin, examine two shorter leading-context windows.

SHADOW evaluates but never changes the decision. STRICT requires both cropped
windows to independently pass *all* original keyword acceptance gates.
No enrollment or threshold edits are performed. Only HELP is eligible until
real CCTV holdout data validates this approach for other keywords.
"""
from __future__ import annotations

from dataclasses import dataclass
import os

from .kws_engine import KeywordDecision, SAMPLE_RATE, SAMPLE_WIDTH

_ALLOWED_MODES = ("off", "shadow", "strict")
_TRIM_MS = (60, 100)
_RECHECK_MIN_CONFIDENCE = 0.90


def far_recheck_mode() -> str:
    value = os.environ.get("MSDS_KWS_FAR_RECHECK", "off").strip().lower()
    return value if value in _ALLOWED_MODES else "off"


@dataclass(frozen=True)
class FarRecheck:
    decision: KeywordDecision | None
    original: KeywordDecision | None
    candidate_accepted: bool
    accepted_trims_ms: tuple[int, ...]
    attempts: int
    mode: str
    reason: str


def recheck_far_segment(engine, pcm: bytes, *, original=None, mode=None) -> FarRecheck:
    """Only strict repeat agreement can change a denied baseline decision.

    Never change the negative-class veto, class margin, duration ratio,
    threshold, or classifier. Noise may coincidentally pass extra windows,
    therefore strict mode remains an explicitly selected experiment.
    """
    if original is None:
        original = engine.diagnose(pcm)
    if mode is None:
        mode = far_recheck_mode()
    if mode not in _ALLOWED_MODES:
        mode = "off"

    def unchanged(reason: str) -> FarRecheck:
        return FarRecheck(original, original, False, (), 0, mode, reason)

    if mode == "off":
        return unchanged("disabled")
    if original is None or original.accepted:
        return unchanged("no_recheck_needed")
    if original.keyword != "help" or original.reason not in (
        "too_close_to_unknown", "insufficient_margin",
    ):
        return unchanged("not_eligible")
    if original.confidence < _RECHECK_MIN_CONFIDENCE:
        return unchanged("low_confidence")
    if not (0.65 <= original.duration_ratio <= 1.30):
        return unchanged("duration_not_suitable")
    if len(pcm) % SAMPLE_WIDTH:
        return unchanged("invalid_pcm")

    # A minimum of 300 ms remains after cutting the maximum 100-ms prefix.
    if len(pcm) < int((0.30 + max(_TRIM_MS) / 1000) * SAMPLE_RATE * SAMPLE_WIDTH):
        return unchanged("too_short")

    accepted = []
    proposed = []
    for trim_ms in _TRIM_MS:
        trim_bytes = int(trim_ms * SAMPLE_RATE / 1000) * SAMPLE_WIDTH
        candidate = engine.diagnose(pcm[trim_bytes:])
        if candidate is not None and candidate.accepted and candidate.keyword == original.keyword:
            accepted.append(trim_ms)
            proposed.append(candidate)

    # Two independent strict passes, same word. Pick the weakest of the
    # passing observations rather than cherry-picking the best confidence.
    agreement = len(accepted) == len(_TRIM_MS)
    decision = min(proposed, key=lambda d: d.confidence) if agreement else original
    if mode != "strict":
        decision = original
    return FarRecheck(
        decision, original, agreement, tuple(accepted), len(_TRIM_MS),
        mode, "recheck_accepted" if agreement else "recheck_rejected",
    )
