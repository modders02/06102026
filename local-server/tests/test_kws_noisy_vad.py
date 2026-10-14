"""Noisy-room KWS VAD regressions (synthetic audio, no CCTV credentials).

These tests exercise frame handling and false segmentation. Passing them does
not establish field accuracy or eliminate the need for held-out real speech.
"""
from pathlib import Path
import sys
import unittest

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from msds.kws_engine import SAMPLE_RATE, StreamingSpeechSegmenter
from msds.camera import Camera


def pcm(samples):
    return np.clip(samples, -0.99, 0.99).astype("<f4").__mul__(32767).astype("<i2").tobytes()


def feed_blocks(vad, audio, chunk_size=4096):
    segments = []
    for pos in range(0, len(audio), chunk_size):
        segments.extend(vad.feed(audio[pos:pos + chunk_size]))
    return segments


class NoisyRoomVADTests(unittest.TestCase):
    def test_stationary_noise_above_old_static_threshold_is_not_speech(self):
        # 0.035 RMS is above the old 0.025 VAD start gate, and corresponded
        # to many 2500ms noise "words" in the CCTV logs.
        rng = np.random.default_rng(9)
        background = rng.normal(0, 0.035, SAMPLE_RATE * 6).astype("float32")
        vad = StreamingSpeechSegmenter()
        segments = feed_blocks(vad, pcm(background))
        self.assertEqual(segments, [])
        self.assertEqual(vad.max_length_drops, 0)
        self.assertGreater(vad.noise_floor_rms, 0.025)
        self.assertFalse(vad.active)

    def test_noisy_short_keyword_isolated_from_ambient(self):
        rng = np.random.default_rng(42)
        sample_count = SAMPLE_RATE * 3
        t = np.arange(sample_count, dtype=np.float32) / SAMPLE_RATE
        audio = rng.normal(0, 0.030, sample_count).astype("float32")
        onset = int(SAMPLE_RATE * 0.8)
        length = int(SAMPLE_RATE * 0.44)
        phrase_t = t[:length]
        envelope = np.sin(np.linspace(0, np.pi, length, dtype=np.float32)) ** 0.5
        audio[onset:onset + length] += (
            0.23 * np.sin(2 * np.pi * 240 * phrase_t) +
            0.10 * np.sin(2 * np.pi * 480 * phrase_t)
        ) * envelope
        vad = StreamingSpeechSegmenter()
        segments = feed_blocks(vad, pcm(audio))
        self.assertEqual(len(segments), 1)
        duration = len(segments[0]) / (SAMPLE_RATE * 2)
        self.assertGreaterEqual(duration, 0.3)
        self.assertLess(duration, 1.0)
        self.assertEqual(vad.max_length_drops, 0)

    def test_arbitrary_ffmpeg_pipe_chunk_size_keeps_same_segment(self):
        rng = np.random.default_rng(5)
        quiet = rng.normal(0, 0.012, SAMPLE_RATE).astype("float32")
        t = np.arange(int(SAMPLE_RATE * 0.50), dtype=np.float32) / SAMPLE_RATE
        voice = 0.26 * np.sin(2 * np.pi * 240 * t) * np.sin(np.linspace(0, np.pi, len(t)))
        audio = pcm(np.concatenate([quiet, voice, quiet]))
        a = feed_blocks(StreamingSpeechSegmenter(), audio, 4096)
        b = feed_blocks(StreamingSpeechSegmenter(), audio, 1000)
        self.assertEqual(len(a), 1)
        self.assertEqual(a, b)

    def test_nonstop_audio_is_dropped_at_max_duration_not_sent_to_kws(self):
        t = np.arange(SAMPLE_RATE * 6, dtype=np.float32) / SAMPLE_RATE
        room = np.zeros(SAMPLE_RATE, dtype=np.float32)
        nonstop = 0.30 * np.sin(2 * np.pi * 200 * t)
        vad = StreamingSpeechSegmenter()
        segments = feed_blocks(vad, pcm(np.concatenate([room, nonstop])))
        self.assertEqual(segments, [])
        self.assertGreaterEqual(vad.max_length_drops, 1)

    def test_camera_pcm_clock_is_generated_from_sample_count(self):
        camera = Camera(id="slot-1", path="cam1", name="test", rtsp="rtsp://example/live")
        command = camera._audio_pcm_cmd("ffmpeg", {"transport": "tcp", "url": "rtsp://example/live"})
        self.assertIn("asetpts=N/SR/TB", command)
        self.assertIn("pcm_s16le", command)


if __name__ == "__main__":
    unittest.main()
