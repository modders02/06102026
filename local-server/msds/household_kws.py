"""Household-specific, speaker-enrolled English keyword profiles.

Only one household may be active in a desktop bridge at a time. Cloud storage
and household membership are governed by Supabase RLS; this local process holds
a per-household cache of acoustic features, never raw WAV files.
"""
from __future__ import annotations

import re
import threading
from pathlib import Path
from uuid import UUID

from .kws_engine import (
    ACTIVE_TEMPLATE_KEYS, DEFAULT_KEYWORDS, KWS_ENGINE, NEGATIVE_CLASS,
    CustomKeywordEngine,
)

_ROOT = Path(__file__).resolve().parents[1] / "kws-households"
_WORD_RE = re.compile(r"^[a-z][a-z0-9_ -]{1,31}$")


def _uuid(value: str) -> str:
    return str(UUID(str(value)))


def phrase_key(phrase: str) -> str:
    raw = str(phrase).strip().lower()
    if not _WORD_RE.fullmatch(raw):
        raise ValueError("English wake words must be 2-32 characters, start with a letter, and use letters, digits, spaces or hyphens.")
    return CustomKeywordEngine.normalize_keyword(raw)


class HouseholdEngine(CustomKeywordEngine):
    """Retain the standard trained safety lexicon alongside household templates."""

    def load(self) -> None:
        super().load()
        if self.data_dir == KWS_ENGINE.data_dir:
            return
        with KWS_ENGINE.lock:
            defaults = {key: list(templates) for key, templates in KWS_ENGINE.templates.items()
                        if key in ACTIVE_TEMPLATE_KEYS}
        with self.lock:
            for key, templates in defaults.items():
                if key not in self.templates:
                    self.templates[key] = templates
            self._calibrate_keyword_margins()


class HouseholdKeywordProfiles:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self.household_id: str | None = None
        self.words: dict[str, dict[str, str]] = {}
        self.engine: HouseholdEngine | None = None

    def activate(self, household_id: str, words: list[dict]) -> dict:
        household_id = _uuid(household_id)
        mapped: dict[str, dict[str, str]] = {}
        keys = set(DEFAULT_KEYWORDS) | {NEGATIVE_CLASS}
        for entry in words:
            word_id = _uuid(entry["id"])
            key = phrase_key(entry["phrase"])
            if key == NEGATIVE_CLASS:
                raise ValueError("'unknown' is reserved for negative training.")
            if key in keys and key not in DEFAULT_KEYWORDS:
                raise ValueError("Duplicate wake-word pronunciation key.")
            if any(other["key"] == key and existing != word_id for existing, other in mapped.items()):
                raise ValueError("Two household phrases normalize to the same keyword.")
            mapped[word_id] = {"key": key, "phrase": entry["phrase"].strip().lower()}
            keys.add(key)
        with self._lock:
            existing = self.household_id == household_id and self.words == mapped
            if not existing:
                self.engine = HouseholdEngine(str(_ROOT / household_id), allowed_keywords=keys)
                self.household_id, self.words = household_id, mapped
            return {**self.status(), "changed": not existing}

    def deactivate(self) -> dict:
        with self._lock:
            self.engine = None
            self.household_id = None
            self.words = {}
            return self.status()

    def current_engine(self) -> CustomKeywordEngine:
        with self._lock:
            return self.engine or KWS_ENGINE

    def enroll(self, household_id: str, word_id: str, sample_id: str, wav_pcm: bytes) -> dict:
        household_id = _uuid(household_id)
        with self._lock:
            if household_id != self.household_id or self.engine is None:
                raise ValueError("Activate this household before enrolling audio.")
            try:
                key = NEGATIVE_CLASS if word_id == NEGATIVE_CLASS else self.words[_uuid(word_id)]["key"]
            except KeyError:
                raise ValueError("Wake word is not registered for the active household.") from None
            return self.engine.enroll(key, wav_pcm, sample_id=sample_id)

    def status(self) -> dict:
        with self._lock:
            engine = self.current_engine()
            info = engine.status()
            sample_ids = {}
            if self.engine is not None:
                for key in self.engine.allowed_keywords:
                    folder = self.engine.data_dir / key
                    sample_ids[key] = sorted(p.stem for p in folder.glob("*.npy")) if folder.exists() else []
            return {
                **info,
                "active_household_id": self.household_id,
                "words": [{"id": word_id, **word} for word_id, word in self.words.items()],
                "sample_ids": sample_ids,
            }


HOUSEHOLD_KWS = HouseholdKeywordProfiles()
