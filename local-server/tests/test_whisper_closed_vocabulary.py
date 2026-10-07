"""Closed-vocabulary Whisper regression tests; no real model or audio device is used."""
from array import array
from pathlib import Path
from types import SimpleNamespace
import math
import sys
import threading
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from msds.camera import is_audible_speech_candidate_pcm
from msds.whisper_engine import WhisperEngine, allowed_transcript


class _FakeModel:
    def __init__(self, segments, language="en", language_probability=0.99):
        self._segments = segments
        self._info = SimpleNamespace(
            language=language,
            language_probability=language_probability,
        )

    def transcribe(self, *_args, **_kwargs):
        return iter(self._segments), self._info


def _segment(text, no_speech_prob=0.05, avg_logprob=-0.25):
    return SimpleNamespace(
        text=text,
        no_speech_prob=no_speech_prob,
        avg_logprob=avg_logprob,
    )


def _engine(*segments, language="en", language_probability=0.99):
    engine = WhisperEngine.__new__(WhisperEngine)
    engine.model = _FakeModel(list(segments), language, language_probability)
    engine.model_name = "fake"
    engine.available = True
    engine.state = "ready"
    engine.error = None
    engine.lock = threading.Lock()
    return engine


class ClosedVocabularyTests(unittest.TestCase):
    def test_canonicalizes_only_approved_phrases(self):
        cases = {
            "HELP ME!": "help me",
            "please help me now": "help me",
            "May sunog po!": "sunog",
            "sonog": "sunog",
            "TULONG!": "tulong",
            "may magnanakaw sa bahay": "magnanakaw",
            "FIRE!": "fire",
            "fire help me": "fire help me",
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(allowed_transcript(raw), expected)

    def test_rejects_non_whitelisted_or_partial_words(self):
        for raw in (
            "",
            "hello",
            "thank you for watching",
            "help",
            "help us",
            "tulungan mo ako",
            "fireplace",
            "bonfire",
            "magnanakawan",
            "ordinary conversation",
        ):
            with self.subTest(raw=raw):
                self.assertEqual(allowed_transcript(raw), "")

    def test_transcribe_rejects_target_phrase_when_audio_looks_like_silence(self):
        engine = _engine(_segment("fire", no_speech_prob=0.92, avg_logprob=-0.20))
        self.assertEqual(engine.transcribe("unused.wav"), "")

    def test_transcribe_rejects_low_confidence_target_phrase(self):
        engine = _engine(_segment("help me", no_speech_prob=0.10, avg_logprob=-1.80))
        self.assertEqual(engine.transcribe("unused.wav"), "")

    def test_transcribe_publishes_only_canonical_phrase_from_valid_speech(self):
        engine = _engine(
            _segment("there is ordinary speech here"),
            _segment("please HELP ME now"),
            _segment("and then more ordinary words"),
        )
        self.assertEqual(engine.transcribe("unused.wav"), "help me")

    def test_transcribe_keeps_tagalog_target(self):
        engine = _engine(_segment("May SUNOG!"), language="tl")
        self.assertEqual(engine.transcribe("unused.wav"), "sunog")


    def test_inaudible_pcm_is_rejected_before_whisper(self):
        silence = (array("h", [0] * 16000)).tobytes()
        quiet = (array("h", [40] * 16000)).tobytes()
        self.assertFalse(is_audible_speech_candidate_pcm(silence))
        self.assertFalse(is_audible_speech_candidate_pcm(quiet))

    def test_audible_pcm_reaches_whisper_gate(self):
        samples = array("h")
        for i in range(16000):
            samples.append(int(2200 * math.sin(2 * math.pi * 440 * i / 16000)))
        self.assertTrue(is_audible_speech_candidate_pcm(samples.tobytes()))


if __name__ == "__main__":
    unittest.main()
