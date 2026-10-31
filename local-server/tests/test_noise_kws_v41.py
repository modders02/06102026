"""V4.1 offline regression tests, no CCTV, live alerts or user audio."""
from __future__ import annotations

import tempfile
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from noise_kws_v4_audio import localize_speech_candidate
from noise_kws_v41_audio import context_preserving_feature
from noise_kws_v4_model import MODEL_VERSION, load_model
from train_noise_augmented_kws import LABELS, SAMPLE_RATE
from train_noise_kws_v41 import (
    V41_NAME, feature_for_audio, score_validation, train_matrices,
)
from evaluate_noise_kws_v41 import resolve_test_root


class FakeExtractor:
    def extract_features(self, pcm):
        # Synthetic ordered features, never real speech.
        count = max(20, int(len(pcm) / (SAMPLE_RATE * 2) * 100))
        positions = np.linspace(-1, 1, count, dtype=np.float32)
        return np.tile(positions[:, None], (1, 32)).astype(np.float32)


class V41ContextTests(unittest.TestCase):
    def test_fixed_context_matches_audited_rule_and_keeps_original_unchanged(self):
        s = np.full(int(2.5 * SAMPLE_RATE), 0.002, dtype=np.float32)
        s[int(0.7 * SAMPLE_RATE):int(1.3 * SAMPLE_RATE)] = 0.22
        untouched = s.copy()
        _, baseline = localize_speech_candidate(s)
        features, status = context_preserving_feature(s, FakeExtractor())
        self.assertEqual(features.shape, (48, 32))
        self.assertEqual(status["reason"], "v4_baseline_plus_fixed_context")
        self.assertEqual(status["context_seconds_per_side"], 0.55)
        self.assertAlmostEqual(status["start_s"], max(0, baseline["start_s"] - 0.55), places=4)
        self.assertAlmostEqual(status["end_s"], min(2.5, baseline["end_s"] + 0.55), places=4)
        self.assertGreaterEqual(status["duration_s"], baseline["duration_s"])
        self.assertLessEqual(status["end_s"], 2.5)
        other_features, other_status = feature_for_audio(s, FakeExtractor())
        np.testing.assert_array_equal(features, other_features)
        self.assertEqual(status, other_status)
        np.testing.assert_array_equal(s, untouched)

    def test_context_is_uniform_and_never_uses_word_labels(self):
        s = np.zeros(int(SAMPLE_RATE * 2.5), dtype=np.float32)
        s[int(SAMPLE_RATE * 0.7):int(SAMPLE_RATE * 1.0)] = 0.4
        x, status = feature_for_audio(s, FakeExtractor())
        # The preprocessing API deliberately has NO label argument.
        self.assertEqual(x.shape, (48, 32))
        self.assertNotIn("label", status)
        self.assertNotIn("expected", status)
        with self.assertRaises(ValueError):
            context_preserving_feature(np.array([np.nan]), FakeExtractor())

    def test_train_and_validation_use_the_same_preprocessing_hook(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            training = [
                {"relative_path": f"train/{label}/a.wav", "label": label}
                for label in LABELS
            ]
            validation = [
                {"relative_path": f"train/{label}/b.wav", "label": label}
                for label in LABELS
            ]
            values = np.zeros(int(2.5 * SAMPLE_RATE), dtype=np.float32)
            values[SAMPLE_RATE // 3:SAMPLE_RATE] = 0.2
            calls = []
            def convert(samples, engine):
                calls.append(len(samples))
                return np.ones((48, 32), np.float32), {"duration_s": 1.9, "reason": "context"}
            with (
                patch("train_noise_kws_v41.wavs", return_value=[root / f"noise{i}.wav" for i in range(3)]),
                patch("train_noise_kws_v41.read_audio", return_value=values),
                patch("train_noise_kws_v41.feature_for_audio", side_effect=convert),
                patch("train_noise_kws_v41.noise_window", return_value=values),
            ):
                tx, ty, vx, vy, info = train_matrices(
                    root, training, validation, FakeExtractor(), variants=0, seed=42,
                )
            self.assertEqual(len(tx), 17)  # Eight original + nine synthetic unknown
            self.assertEqual(len(vx), 8)
            self.assertEqual(len(calls), 25)
            self.assertEqual(info["validation_augmentations"], 0)
            self.assertEqual(info["original_train_wavs"], 8)
            self.assertEqual(info["original_session_validation_wavs"], 8)
            self.assertEqual(set(ty), set(range(8)))
            self.assertEqual(set(vy), set(range(8)))

    def test_new_candidate_name_is_not_v3_or_v4(self):
        self.assertEqual(V41_NAME, "noise_temporal_context_v41.npz")
        self.assertNotEqual(V41_NAME, "noise_temporal_cnn_v4.npz")
        self.assertNotEqual(V41_NAME, "noise_augmented_shadow_v3.npz")
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            self.assertEqual(
                resolve_test_root(root, root / "fresh-v41-20261101"),
                (root / "fresh-v41-20261101").resolve(),
            )
            with self.assertRaisesRegex(ValueError, "conflicts"):
                resolve_test_root(root, root / "holdout" / "fire")


if __name__ == "__main__":
    unittest.main()
