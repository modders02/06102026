"""Tests for frozen Whisper English offline benchmark, without model downloads."""
from __future__ import annotations

import hashlib
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
import wave

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from benchmark_whisper_kws_v6 import (
    LABELS, SAMPLE_RATE, MODEL_ID, benchmark, check_dataset,
    keyword_events, read_capture_pcm16, score_transcripts, transcribe_one,
)


class FakeASR:
    def __init__(self, sentence="Fire!"):
        self.sentence = sentence
        self.calls = []

    def transcribe(self, audio, **kwargs):
        self.calls.append((audio.copy(), kwargs))
        return iter([SimpleNamespace(start=0.2, end=0.8, text=self.sentence)]), None


def write_wave(path: Path, freq: float):
    path.parent.mkdir(parents=True, exist_ok=True)
    t = np.arange(SAMPLE_RATE, dtype=np.float32) / SAMPLE_RATE
    audio = (np.sin(2*np.pi*freq*t)*12000).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(audio.tobytes())


def setup_dataset(temp: Path) -> tuple[Path, Path, Path]:
    root = temp / "neural-kws-data"
    test = root / "independent-2026"
    for index, label in enumerate(LABELS, 1):
        write_wave(test / "train" / label / "take.wav", 220 + index * 15)
    root.mkdir(parents=True, exist_ok=True)
    manifest = root / "group_manifest_v3.csv"
    manifest.write_text(
        "relative_path,speaker_id,session_id,sha256\n"
        + "train/fire/old.wav,speaker1,session1,"
        + hashlib.sha256(b"original training bytes").hexdigest() + "\n",
        encoding="utf-8",
    )
    return root, test, manifest


class WhisperV6ResearchTests(unittest.TestCase):
    def test_word_spotting_is_exact_case_normalized_and_token_based(self):
        self.assertEqual(keyword_events("HELP! call POLICE, fire!"), ["help", "police", "fire"])
        self.assertEqual(keyword_events("Firefighter helpful ambulance-like"),
                         ["ambulance"])
        self.assertEqual(keyword_events("Dangerous firehouse emérgency"), [])
        self.assertEqual(keyword_events("ambulance, AMBULANCE."), ["ambulance", "ambulance"])

    def test_score_requires_no_wrong_word_and_counts_unknown_false_positive(self):
        rows = [
            {"expected": "fire", "keyword_events": ["fire"]},
            {"expected": "fire", "keyword_events": ["fire", "police"]},
            {"expected": "fire", "keyword_events": []},
            {"expected": "unknown", "keyword_events": ["help"]},
            {"expected": "unknown", "keyword_events": []},
        ]
        for label in LABELS:
            if label not in {"fire", "unknown"}:
                rows.append({"expected": label, "keyword_events": []})
        scored = score_transcripts(rows)
        self.assertEqual(scored["positive_wavs"], 9)
        self.assertEqual(scored["correctly_accepted_positive_wavs"], 1)
        self.assertEqual(scored["unknown_false_positive_count"], 1)
        self.assertEqual(scored["per_label"]["fire"]["wrong_keyword_events"], 1)
        self.assertEqual(scored["per_label"]["unknown"]["accepted_correct"], 1)

    def test_full_wave_reader_checks_pcm_and_no_cropping(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            good = root / "good.wav"
            write_wave(good, 400)
            samples, stats = read_capture_pcm16(good)
            self.assertEqual(len(samples), SAMPLE_RATE)
            self.assertEqual(stats["duration_seconds"], 1.0)
            self.assertGreater(stats["rms_dbfs"], -40)
            self.assertIn("first_200ms_rms_dbfs", stats)
            with wave.open(str(root / "invalid.wav"), "wb") as w:
                w.setnchannels(2)
                w.setsampwidth(2)
                w.setframerate(SAMPLE_RATE)
                w.writeframes(b"\0" * SAMPLE_RATE * 4)
            with self.assertRaisesRegex(ValueError, "Expected uncompressed"):
                read_capture_pcm16(root / "invalid.wav")

    def test_deterministic_asr_kwargs_no_prompt_or_vad(self):
        model = FakeASR("Emergency.")
        source = np.zeros(SAMPLE_RATE, np.float32)
        transcript, segments = transcribe_one(model, source)
        self.assertEqual(transcript, "Emergency.")
        self.assertEqual(len(segments), 1)
        audio, kwargs = model.calls[0]
        self.assertEqual(len(audio), len(source))
        self.assertEqual(kwargs["language"], "en")
        self.assertEqual(kwargs["beam_size"], 5)
        self.assertEqual(kwargs["temperature"], 0)
        self.assertIsNone(kwargs["initial_prompt"])
        self.assertFalse(kwargs["vad_filter"])
        self.assertFalse(kwargs["condition_on_previous_text"])

    def test_no_duplicate_training_or_test_audio_and_no_legacy_holdout(self):
        with tempfile.TemporaryDirectory() as d:
            root, test, manifest = setup_dataset(Path(d))
            files, signature = check_dataset(root, test, manifest)
            self.assertEqual(len(files), 8)
            self.assertEqual(len(signature), 64)
            with self.assertRaisesRegex(ValueError, "training/legacy"):
                check_dataset(root, root / "holdout", manifest)
            second_file = test / "train" / "help" / "take.wav"
            second_file.write_bytes(
                (test / "train" / "fire" / "take.wav").read_bytes()
            )
            with self.assertRaisesRegex(ValueError, "Duplicate WAV"):
                check_dataset(root, test, manifest)

    def test_benchmark_is_offline_and_model_is_not_trained(self):
        with tempfile.TemporaryDirectory() as d:
            root, test, manifest = setup_dataset(Path(d))
            fake = FakeASR("Fire!")
            report = benchmark(root, test, manifest, model=fake)
            self.assertEqual(len(fake.calls), len(LABELS))
            self.assertEqual(report["model_id"], MODEL_ID)
            self.assertFalse(report["retraining_performed"])
            self.assertFalse(report["active_msds_modified"])
            self.assertFalse(report["alert_routing_modified"])
            self.assertEqual(report["positive_wavs"], 7)
            self.assertEqual(report["correctly_accepted_positive_wavs"], 1)
            self.assertEqual(report["unknown_false_positive_count"], 1)
            self.assertEqual(len(report["per_file"]), 8)
            self.assertEqual(report["per_file"][0]["transcript"], "Fire!")


if __name__ == "__main__":
    unittest.main()
