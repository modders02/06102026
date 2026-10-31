"""Manual-crop audit regressions. Tests never load real WAVs or play audio."""
from __future__ import annotations

import csv
import io
from pathlib import Path
import sys
import tempfile
import unittest
import wave

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from audit_noise_kws_v4_crops import (
    COLUMNS, append_review, load_reviews, play_original_then_crop, render_summary, wav_bytes,
)
from train_noise_augmented_kws import SAMPLE_RATE


class V4ManualCropAuditTests(unittest.TestCase):
    def test_in_memory_wav_keeps_pcm_rate_duration_and_no_files(self):
        samples = np.zeros(SAMPLE_RATE * 2, dtype=np.float32)
        samples[SAMPLE_RATE//4:SAMPLE_RATE//2] = 0.15
        copy = samples.copy()
        blob = wav_bytes(samples)
        with wave.open(io.BytesIO(blob), "rb") as audio:
            self.assertEqual(audio.getnchannels(), 1)
            self.assertEqual(audio.getsampwidth(), 2)
            self.assertEqual(audio.getframerate(), SAMPLE_RATE)
            self.assertEqual(audio.getnframes(), len(samples))
            self.assertEqual(len(audio.readframes(len(samples))), len(samples) * 2)
        np.testing.assert_array_equal(samples, copy)

    def test_audio_validation_rejects_empty_nonfinite_or_wrong_rate(self):
        for invalid in (np.array([], np.float32),
                        np.array([float("nan")], np.float32),
                        np.ones((3, 2), np.float32)):
            with self.subTest(invalid=invalid.shape):
                with self.assertRaisesRegex(ValueError, "nonempty"):
                    wav_bytes(invalid)
        with self.assertRaisesRegex(ValueError, "sample rate"):
            wav_bytes(np.ones(10, np.float32), sample_rate=10)

    def test_winsound_memory_playback_is_ordered_and_synchronous_by_default(self):
        # Python winsound has no SND_SYNC constant. SND_MEMORY alone is sync;
        # importantly, SND_ASYNC must not be supplied for memory playback.
        class FakeWinSound:
            SND_MEMORY = 4
            SND_ASYNC = 1

            def __init__(self):
                self.played = []

            def PlaySound(self, blob, flags):
                self.played.append((blob, flags))

        fake = FakeWinSound()
        original = wav_bytes(np.ones(1600, dtype=np.float32) * 0.1)
        crop = wav_bytes(np.ones(800, dtype=np.float32) * 0.2)
        play_original_then_crop(fake, original, crop)
        self.assertEqual(
            fake.played,
            [(original, fake.SND_MEMORY), (crop, fake.SND_MEMORY)],
        )
        self.assertEqual(
            [flags & fake.SND_ASYNC for _, flags in fake.played], [0, 0]
        )

    def test_private_csv_writes_only_metadata_and_is_resumeable(self):
        with tempfile.TemporaryDirectory() as temp:
            private = Path(temp) / "artifacts" / "noise-v4-review.csv"
            self.assertFalse(private.parent.exists())
            row = {
                "relative_path": "train/fire/test.wav",
                "sha256": "abc123", "label": "fire",
                "original_duration_s": "2.5000",
                "crop_start_s": "0.4", "crop_end_s": "1.1",
                "crop_duration_s": "0.7", "crop_reason": "contrast_energy",
                "crop_complete_word": "N",
                "v4_raw_top": "unknown",
                "v4_accepted": "unknown",
                "v4_decision_reason": "top_class_unknown",
            }
            append_review(private, row)
            saved = load_reviews(private)
            self.assertEqual(len(saved), 1)
            self.assertEqual(saved[row["relative_path"]], row)
            with private.open("r", encoding="utf-8", newline="") as f:
                reader = csv.DictReader(f)
                self.assertEqual(tuple(reader.fieldnames), COLUMNS)
                self.assertEqual(list(reader), [row])
            self.assertFalse(list(Path(temp).rglob("*.wav")))
            second = dict(row, relative_path="train/intruder/test.wav", label="intruder",
                          crop_complete_word="Y")
            append_review(private, second)
            self.assertEqual(len(load_reviews(private)), 2)
            render_summary(load_reviews(private))

    def test_review_file_refuses_duplicate_or_unknown_decision(self):
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp) / "test.csv"
            with out.open("w", encoding="utf-8", newline="") as f:
                writer = csv.DictWriter(f, fieldnames=COLUMNS)
                writer.writeheader()
                item = {key: "" for key in COLUMNS}
                item.update(relative_path="train/fire/a.wav",
                            crop_complete_word="N")
                writer.writerow(item)
                writer.writerow(item)
            with self.assertRaisesRegex(ValueError, "Duplicate"):
                load_reviews(out)
            with out.open("w", encoding="utf-8", newline="") as f:
                writer = csv.DictWriter(f, fieldnames=COLUMNS)
                writer.writeheader()
                writer.writerow(dict(item, crop_complete_word="YES"))
            with self.assertRaisesRegex(ValueError, "unsupported"):
                load_reviews(out)


if __name__ == "__main__":
    unittest.main()
