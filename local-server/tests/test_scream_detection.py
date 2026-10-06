"""Regression tests for lightweight CCTV scream candidate detection."""
from __future__ import annotations

import math
import struct
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from msds.camera import detect_scream_pcm


def sine_pcm(frequency: float, amplitude: float, seconds: float = 1.0, sample_rate: int = 16000) -> bytes:
    count = int(seconds * sample_rate)
    samples = []
    for index in range(count):
        value = int(max(-1.0, min(1.0, amplitude * math.sin(2 * math.pi * frequency * index / sample_rate))) * 32767)
        samples.append(value)
    return struct.pack("<" + "h" * len(samples), *samples)


class ScreamDetectionTests(unittest.TestCase):
    def test_detects_loud_high_frequency_candidate(self):
        self.assertGreaterEqual(detect_scream_pcm(sine_pcm(2500, 0.7)), 0.6)

    def test_rejects_loud_low_frequency_tone(self):
        self.assertEqual(detect_scream_pcm(sine_pcm(300, 0.7)), 0.0)

    def test_rejects_quiet_high_frequency_tone(self):
        self.assertEqual(detect_scream_pcm(sine_pcm(2500, 0.03)), 0.0)

    def test_rejects_too_short_audio(self):
        self.assertEqual(detect_scream_pcm(b"\x00\x00" * 1000), 0.0)


if __name__ == "__main__":
    unittest.main()
