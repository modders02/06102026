"""Household voice enrollment must remain isolated and preserve core safety rules."""
import math
import sys
import tempfile
import unittest
import wave
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from msds import household_kws
from msds.kws_engine import (
    CustomKeywordEngine, KWS_ENGINE, SAMPLE_RATE, NEGATIVE_CLASS,
)

A = "11111111-1111-4111-8111-111111111111"
B = "22222222-2222-4222-8222-222222222222"
WORD_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
WORD_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"


def sample(hz=330.0):
    t = np.arange(int(SAMPLE_RATE * .62), dtype=np.float32) / SAMPLE_RATE
    signal = (.32 * np.sin(2 * math.pi * hz * t)).astype(np.float32)
    return (signal * 32767).astype("<i2").tobytes()


def wav_bytes(pcm):
    result = BytesIO()
    with wave.open(result, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(SAMPLE_RATE)
        audio.writeframes(pcm)
    return result.getvalue()


class HouseholdVoiceTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.root_patch = patch.object(household_kws, "_ROOT", Path(self.folder.name))
        self.root_patch.start()
        self.profiles = household_kws.HouseholdKeywordProfiles()

    def tearDown(self):
        self.profiles.deactivate()
        self.root_patch.stop()
        self.folder.cleanup()

    def test_profiles_are_separate_and_same_household_sync_is_idempotent(self):
        first = self.profiles.activate(A, [{"id": WORD_A, "phrase": "help me"}])
        self.assertTrue(first["changed"])
        self.assertIn("help_me", first["active_keywords"])
        self.assertFalse(self.profiles.activate(A, [{"id": WORD_A, "phrase": "help me"}])["changed"])
        for index in range(3):
            res = self.profiles.enroll(A, WORD_A, f"{index:032x}", sample(300 + index))
        self.assertEqual(res["templates"], 3)
        self.assertTrue(res["ready"])
        same = self.profiles.enroll(A, WORD_A, f"{index:032x}", sample(300 + index))
        self.assertTrue(same["already_enrolled"])
        self.assertEqual(same["templates"], 3)
        first_engine = self.profiles.current_engine()
        second = self.profiles.activate(B, [{"id": WORD_B, "phrase": "stay safe"}])
        self.assertTrue(second["changed"])
        self.assertNotIn("help_me", second["active_keywords"])
        self.assertEqual(self.profiles.status()["sample_ids"]["stay_safe"], [])
        with self.assertRaises(ValueError):
            self.profiles.enroll(A, WORD_A, "a" * 32, sample())
        self.profiles.activate(A, [{"id": WORD_A, "phrase": "help me"}])
        self.assertEqual(self.profiles.status()["keywords"]["help_me"], 3)
        self.assertNotEqual(first_engine.data_dir, self.profiles.current_engine().data_dir if self.profiles.household_id == B else Path(self.folder.name) / B)

    def test_negative_examples_required_for_new_profile(self):
        self.profiles.activate(A, [{"id": WORD_A, "phrase": "call ambulance"}])
        engine = self.profiles.current_engine()
        for index in range(3):
            self.profiles.enroll(A, WORD_A, f"{index:032x}", sample(320 + index))
        for index in range(5):
            self.profiles.enroll(A, NEGATIVE_CLASS, f"{100+index:032x}", sample(750 + index * 50))
        self.assertTrue(engine.status()["open_set_ready"])
        self.assertNotIn("unknown", engine.status()["ready_keywords"])

    def test_wav_bytes_decode_and_default_scope_stays_fixed(self):
        pcm = sample()
        decoded = CustomKeywordEngine._read_wav_as_pcm16k_mono(wav_bytes(pcm))
        self.assertEqual(decoded, pcm)
        with self.assertRaisesRegex(ValueError, "English-only thesis scope"):
            KWS_ENGINE._require_active_keyword("tulong")
        with self.assertRaises(ValueError):
            household_kws.phrase_key("../../unsafe")


if __name__ == "__main__":
    unittest.main()
