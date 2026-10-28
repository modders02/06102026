"""Regression checks for opt-in speech-preserving CCTV filtering.

Run: python -m unittest local-server/tests/test_kws_voice_profile.py -v
"""
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from msds.kws_audio_filters import (
    PROFILES, pcm_audio_filter, publisher_audio_filter, robust_mode, selected_profile,
)


class VoiceProfileTests(unittest.TestCase):
    def test_voice_profile_selectable_without_changing_stable_default(self):
        with patch.dict(os.environ, {"MSDS_KWS_ROBUST_MODE": "voice"}):
            self.assertEqual(robust_mode(), "voice")
            self.assertEqual(selected_profile(), "voice")

    def test_voice_profile_preserves_wider_speech_band(self):
        filt = pcm_audio_filter(enabled=True, profile="voice")
        self.assertIn("highpass=f=90", filt)
        self.assertIn("lowpass=f=5000", filt)
        self.assertIn(PROFILES["voice"], filt)
        self.assertIn("aresample=16000", filt)

    def test_maximum_stays_unchanged(self):
        filt = pcm_audio_filter(enabled=True, profile="maximum")
        self.assertIn("highpass=f=120", filt)
        self.assertIn("lowpass=f=4200", filt)
        self.assertIn("nr=97", filt)

    def test_publisher_and_pcm_agree_when_voice_playback_enabled(self):
        with patch.dict(os.environ, {
            "MSDS_KWS_ROBUST_MODE": "voice",
            "MSDS_RTSP_AUDIO_DENOISE_PLAYBACK": "1",
        }):
            filt = publisher_audio_filter()
            self.assertIn("highpass=f=90", filt)
            self.assertIn("lowpass=f=5000", filt)
            self.assertIn(PROFILES["voice"], filt)

    def test_unfiltered_pcm_remains_unfiltered(self):
        self.assertNotIn("afftdn", pcm_audio_filter(enabled=False, profile="voice"))


if __name__ == "__main__":
    unittest.main()
