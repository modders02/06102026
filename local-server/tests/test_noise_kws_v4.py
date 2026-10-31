"""V4 offline research unit checks; no camera, external packages or real voices."""
from __future__ import annotations

import tempfile
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from noise_kws_v4_audio import localize_speech_candidate, temporal_logmel
from noise_kws_v4_model import (
    MODEL_VERSION, fit_temporal_cnn, initialize, load_model,
    predict_fixed_gate, predict_proba, save_model,
)
from train_noise_augmented_kws import LABELS, SAMPLE_RATE
from train_noise_kws_v4 import score_validation
from evaluate_noise_kws_v4 import resolve_test_root


class FakeLogMelEngine:
    def extract_features(self, pcm):
        # A temporally changing synthetic sequence, never actual voice.
        x = np.linspace(-1.0, 1.0, 72, dtype=np.float32)
        return np.tile(x[:, None], (1, 32))


class V4OfflineTests(unittest.TestCase):
    def test_localizer_is_label_blind_deterministic_and_bounded(self):
        src = np.zeros(int(2.5 * SAMPLE_RATE), np.float32)
        src[:] = 0.004
        src[int(0.7 * SAMPLE_RATE):int(1.25 * SAMPLE_RATE)] = 0.25
        original = src.copy()
        crop, meta = localize_speech_candidate(src)
        self.assertLessEqual(len(crop), int(1.6 * SAMPLE_RATE))
        self.assertGreaterEqual(len(crop), int(0.6 * SAMPLE_RATE))
        self.assertLessEqual(meta["start_s"], 0.75)
        self.assertGreaterEqual(meta["end_s"], 1.2)
        self.assertEqual(meta["reason"], "contrast_energy")
        again, details = localize_speech_candidate(src)
        self.assertEqual(meta, details)
        np.testing.assert_array_equal(crop, again)
        np.testing.assert_array_equal(src, original)

    def test_localizer_rejects_invalid_inputs_and_caps_long_active_audio(self):
        with self.assertRaisesRegex(ValueError, "nonempty"):
            localize_speech_candidate(np.array([], np.float32))
        with self.assertRaisesRegex(ValueError, "nonempty"):
            localize_speech_candidate(np.array([np.nan], np.float32))
        with self.assertRaisesRegex(ValueError, "duration"):
            localize_speech_candidate(np.ones(8000), max_seconds=0.2)
        short = np.ones(4000, np.float32) * 0.01
        crop, detail = localize_speech_candidate(short)
        np.testing.assert_array_equal(crop, short)
        self.assertEqual(detail["reason"], "short_original")
        long = 0.07 + 0.02 * np.sin(np.linspace(0, 200, int(2.5 * SAMPLE_RATE)))
        long = np.asarray(long, np.float32)
        crop, meta = localize_speech_candidate(long)
        self.assertTrue(np.isfinite(crop).all())
        self.assertLessEqual(len(crop), int(1.6 * SAMPLE_RATE))
        self.assertIn("reason", meta)

    def test_ordered_mel_frames_and_feature_shape(self):
        seq = temporal_logmel(
            np.ones(SAMPLE_RATE, np.float32) * 0.04, FakeLogMelEngine()
        )
        self.assertEqual(seq.shape, (48, 32))
        self.assertLess(seq[0, 0], seq[-1, 0])
        self.assertTrue(np.allclose(seq[:, 0], seq[:, 31]))
        with self.assertRaisesRegex(ValueError, "steps"):
            temporal_logmel(np.ones(SAMPLE_RATE), FakeLogMelEngine(), steps=5)

    def test_cnn_forward_and_explicit_fixed_gate(self):
        rng = np.random.default_rng(6)
        x = rng.normal(size=(4, 48, 32)).astype(np.float32)
        w = initialize(x, 8)
        p = predict_proba(x, w)
        self.assertEqual(p.shape, (4, 8))
        np.testing.assert_allclose(p.sum(axis=1), 1.0, atol=1e-6)
        self.assertEqual(predict_fixed_gate(np.array([
            0.85, 0.03, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02
        ])), 0)
        self.assertEqual(predict_fixed_gate(np.array([
            0.74, 0.06, 0.05, 0.03, 0.03, 0.02, 0.02, 0.05
        ])), 7)
        self.assertEqual(predict_fixed_gate(np.array([
            0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.04, 0.90
        ])), 7)

    def test_grouped_training_early_stops_and_artifact_is_independent(self):
        rng = np.random.default_rng(13)
        x = rng.normal(size=(32, 48, 32)).astype(np.float32)
        for label in range(8):
            x[4 * label:4 * label + 4, :, label] += 2.0
        y = np.repeat(np.arange(8), 4)
        valid = rng.normal(size=(8, 48, 32)).astype(np.float32)
        vy = np.arange(8)
        w, status = fit_temporal_cnn(
            x, y, valid, vy, epochs=3, patience=2, seed=42,
        )
        self.assertGreaterEqual(status["best_epoch"], 1)
        self.assertLessEqual(status["epochs_ran"], 3)
        self.assertEqual(w["conv_w"].shape, (160, 24))
        self.assertTrue(np.isfinite(w["out_w"]).all())
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp) / "artifacts" / "noise_temporal_cnn_v4.npz"
            save_model(out, w, {"version": MODEL_VERSION, "research_only": True})
            w2, meta = load_model(out)
            np.testing.assert_array_equal(w2["conv_w"], w["conv_w"])
            self.assertTrue(meta["research_only"])
            self.assertFalse(
                (out.parent / "noise_augmented_shadow_v3.npz").exists()
            )

    def test_frozen_validation_metrics_show_wrong_class_vs_low_confidence(self):
        y = np.array([0, 1, 7])
        originals = [
            {"relative_path": "train/help/a.wav", "label": "help"},
            {"relative_path": "train/fire/a.wav", "label": "fire"},
            {"relative_path": "train/unknown/a.wav", "label": "unknown"},
        ]
        p = np.array([
            [0.74, 0.06, 0.04, 0.04, 0.03, 0.03, 0.03, 0.03],
            [0.10, 0.08, 0.01, 0.01, 0.01, 0.01, 0.01, 0.77],
            [0.90, 0.02, 0.02, 0.01, 0.01, 0.01, 0.01, 0.02],
        ])
        with patch("train_noise_kws_v4.predict_proba", return_value=p):
            result = score_validation(
                np.zeros((3, 48, 32), np.float32),
                y, {}, originals
            )
        self.assertEqual(result["raw_top_positive_accuracy"], 0.5)
        self.assertEqual(result["fixed_gate_positive_recall"], 0.0)
        self.assertEqual(result["unknown_false_positive_count"], 1)
        self.assertEqual(
            result["validation_per_file"][0]["decision_reason"],
            "below_fixed_threshold",
        )
        self.assertEqual(
            result["validation_per_file"][1]["decision_reason"],
            "top_class_unknown",
        )

    def test_independent_test_directory_must_not_reuse_training_or_holdout(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "private"
            self.assertEqual(
                resolve_test_root(root, root / "independent-v4-test"),
                (root / "independent-v4-test").resolve()
            )
            for forbidden in (
                root, root / "train" / "help",
                root / "holdout", root / "staging" / "verified",
                root / "capture-pilot" / "train",
            ):
                with self.subTest(forbidden=forbidden):
                    with self.assertRaisesRegex(ValueError, "training|conflicts"):
                        resolve_test_root(root, forbidden)


if __name__ == "__main__":
    unittest.main()
