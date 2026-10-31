"""Regression tests for isolated training/augmentation and WAV capture.

No camera, pretrained model, enrollment data or external network is required.
"""
from __future__ import annotations

import io
from pathlib import Path
import tempfile
import unittest
import wave
import sys

import numpy as np

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
from capture_noise_kws_wavs import capture_wav, destination
from train_noise_augmented_kws import (
    ACCEPT_THRESHOLD, DIM, LABELS, SAMPLE_RATE, augment_audio, check_disjoint,
    encode_dataset, evaluate_holdout, feature_vector, infer_probs, inventory,
    load_model, noise_window, predict_one, read_audio, save_model, train_mlp,
)
from msds.kws_engine import CustomKeywordEngine


def write_wav(path: Path, samples: np.ndarray, rate: int = SAMPLE_RATE):
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as file:
        file.setnchannels(1)
        file.setsampwidth(2)
        file.setframerate(rate)
        file.writeframes((np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes())


class NoiseAugmentedKWSTests(unittest.TestCase):
    def test_dataset_inventory_requires_unknown_and_disjoint_holdout(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            summary = inventory(root)
            self.assertFalse(summary["ready"])
            self.assertEqual(summary["required_noise"], 3)
            a = root / "train" / "help" / "same.wav"
            b = root / "holdout" / "help" / "same.wav"
            a.parent.mkdir(parents=True)
            b.parent.mkdir(parents=True)
            a.write_bytes(b"same wav data")
            b.write_bytes(b"same wav data")
            with self.assertRaisesRegex(ValueError, "Duplicate WAV"):
                check_disjoint({"help": [a]}, {"help": [b]}, [])

    def test_augmentation_is_reproducible_and_does_not_modify_original(self):
        sr = SAMPLE_RATE
        t = np.arange(sr, dtype=np.float32) / sr
        clean = (0.1 * np.sin(2 * np.pi * 390 * t)).astype(np.float32)
        noise = (0.1 * np.sin(2 * np.pi * 70 * t)).astype(np.float32)
        original = clean.copy()
        out1 = augment_audio(clean, [noise], np.random.default_rng(23),
                             snr_db=5, force_noise=True)
        out2 = augment_audio(clean, [noise], np.random.default_rng(23),
                             snr_db=5, force_noise=True)
        np.testing.assert_allclose(out1, out2)
        np.testing.assert_array_equal(clean, original)
        self.assertFalse(np.array_equal(out1, clean))
        self.assertEqual(out1.shape, clean.shape)
        self.assertLessEqual(float(np.max(np.abs(out1))), 1)
        self.assertEqual(len(noise_window(noise[:500], 1600, np.random.default_rng(3))), 1600)
        with self.assertRaises(ValueError):
            augment_audio(clean, [], np.random.default_rng(2), force_noise=True)

    def test_feature_extractor_mlps_and_numpy_only_model(self):
        t = np.arange(12000, dtype=np.float32) / SAMPLE_RATE
        signal = (0.15 * np.sin(2 * np.pi * 350 * t)).astype(np.float32)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            extractor = CustomKeywordEngine(data_dir=str(root / "not-active-templates"))
            vec = feature_vector(signal, extractor)
            self.assertEqual(vec.shape, (DIM,))
            self.assertTrue(np.isfinite(vec).all())
            wav = root / "test.wav"
            write_wav(wav, signal)
            self.assertEqual(len(read_audio(wav, extractor)), len(signal))
            with self.assertRaises(ValueError):
                read_audio(root / "missing.wav", extractor)

            rng = np.random.default_rng(44)
            x = rng.normal(size=(48, DIM)).astype(np.float32)
            y = np.tile(np.arange(len(LABELS)), 6)
            w = train_mlp(x, y, epochs=2, seed=44)
            prob = infer_probs(x, w)
            self.assertEqual(prob.shape, (48, len(LABELS)))
            np.testing.assert_allclose(prob.sum(axis=1), 1, atol=1e-5)
            predicted, conf, margin = predict_one(x[0], w)
            self.assertIn(predicted, LABELS)
            self.assertTrue(0 <= conf <= 1)
            self.assertTrue(0 <= margin <= 1)
            outcome = evaluate_holdout(x, y, w)
            self.assertIn("unknown_false_positive_rate", outcome)
            model = root / "artifacts" / "candidate.npz"
            from train_noise_augmented_kws import MODEL_VERSION
            save_model(model, w, {"version": MODEL_VERSION, "labels": LABELS})
            loaded, metadata = load_model(model)
            self.assertEqual(tuple(metadata["labels"]), LABELS)
            np.testing.assert_allclose(infer_probs(x, loaded), prob, atol=1e-6)
            self.assertFalse((root / "not-active-templates").exists()
                             and list((root / "not-active-templates").glob("*.npy")))

    def test_local_capture_writes_only_explicit_split_and_valid_wav(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.assertEqual(destination(root, "help", "holdout"),
                             root / "holdout" / "help")
            self.assertEqual(destination(root, "noise", "train"), root / "noise")
            with self.assertRaises(ValueError):
                destination(root, "../help", "train")
            samples = (np.sin(np.linspace(0, 40 * np.pi, SAMPLE_RATE, dtype=np.float32))
                       * 0.25).astype(np.float32)
            pcm = (samples * 32767).astype("<i2").tobytes()
            dst = root / "holdout" / "help" / "capture.wav"
            n, digest = capture_wav(io.BytesIO(pcm), dst, 1.0)
            self.assertEqual(n, len(pcm))
            self.assertEqual(len(digest), 64)
            with wave.open(str(dst), "rb") as file:
                self.assertEqual(file.getframerate(), SAMPLE_RATE)
                self.assertEqual(file.getnframes(), SAMPLE_RATE)
            with self.assertRaises(FileExistsError):
                capture_wav(io.BytesIO(pcm), dst, 1.0)
            with self.assertRaises(ValueError):
                capture_wav(io.BytesIO(b"\x00\x00" * SAMPLE_RATE), root / "silent.wav", 1.0)
            self.assertFalse((root / "silent.wav").exists())


if __name__ == "__main__":
    unittest.main()
