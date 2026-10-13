"""Isolated short HELP ASR tests: no real Whisper model or CCTV needed."""
import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from msds import kws_verifier


class FakeASR:
    def __init__(self, text, no_speech_prob, avg_logprob):
        self.text = text
        self.no_speech_prob = no_speech_prob
        self.avg_logprob = avg_logprob
        self.kwargs = None

    def transcribe(self, *args, **kwargs):
        self.kwargs = kwargs
        return ([SimpleNamespace(
            text=self.text,
            no_speech_prob=self.no_speech_prob,
            avg_logprob=self.avg_logprob,
        )], None)


class ShortHelpASRTests(unittest.TestCase):
    def verify(self, *, word="help", text="Help!", prob=0.78,
               logprob=-0.2, enabled="1", duration=0.38):
        asr = FakeASR(text, prob, logprob)
        pcm = bytes([1, 0]) * int(duration * 16000)
        with patch.dict(os.environ, {
            "MSDS_KWS_VERIFY_ASR": "1",
            "MSDS_KWS_HELP_RESCUE": "1",
            "MSDS_KWS_SHORT_HELP_ASR": enabled,
        }), patch.object(kws_verifier, "_get_model", return_value=asr):
            decision = kws_verifier.verify_kws_segment(pcm, word)
        return decision, asr

    def test_short_help_with_high_no_speech_prob_is_reviewed(self):
        v, model = self.verify()
        self.assertTrue(v.accepted)
        self.assertEqual(v.state, "verified")
        self.assertEqual(v.transcript, "Help!")
        self.assertEqual(v.raw_transcript, "Help!")
        self.assertAlmostEqual(v.no_speech_prob, 0.78)
        self.assertAlmostEqual(v.avg_logprob, -0.2)
        self.assertIsNone(model.kwargs["no_speech_threshold"])

    def test_disabled_opt_in_keeps_existing_speech_filter(self):
        v, model = self.verify(enabled="0")
        self.assertFalse(v.accepted)
        self.assertEqual(v.state, "verification_no_speech")
        self.assertEqual(v.raw_transcript, "Help!")
        self.assertEqual(model.kwargs["no_speech_threshold"], 0.6)

    def test_long_help_keeps_original_filter(self):
        v, model = self.verify(duration=1.05)
        self.assertFalse(v.accepted)
        self.assertEqual(model.kwargs["no_speech_threshold"], 0.6)

    def test_short_fire_is_not_relaxed(self):
        v, model = self.verify(word="fire")
        self.assertFalse(v.accepted)
        self.assertEqual(model.kwargs["no_speech_threshold"], 0.6)

    def test_low_confidence_or_empty_text_fails_closed(self):
        for text, logprob in (
            ("Help!", -0.75), ("Help!", -1.2), ("", -0.1),
            ("Hello", -0.1), ("Fire", -0.1),
        ):
            with self.subTest(text=text, logprob=logprob):
                v, _ = self.verify(text=text, logprob=logprob)
                self.assertFalse(v.accepted)
        v, _ = self.verify(text="", prob=0.99)
        self.assertEqual(v.state, "verification_no_speech")

    def test_no_help_rescue_opt_in_cannot_relax_filter(self):
        asr = FakeASR("help", 0.8, -0.2)
        with patch.dict(os.environ, {
            "MSDS_KWS_VERIFY_ASR": "1",
            "MSDS_KWS_HELP_RESCUE": "0",
            "MSDS_KWS_SHORT_HELP_ASR": "1",
        }), patch.object(kws_verifier, "_get_model", return_value=asr):
            v = kws_verifier.verify_kws_segment(bytes([1, 0]) * 7000, "help")
        self.assertFalse(v.accepted)
        self.assertEqual(asr.kwargs["no_speech_threshold"], 0.6)


if __name__ == "__main__":
    unittest.main()
