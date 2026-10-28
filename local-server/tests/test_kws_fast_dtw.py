"""Numerical-equivalence checks for optional wavefront DTW acceleration.

These tests are synthetic. Verify real CCTV recognition and latency before
treating the accelerated path as a performance upgrade.
"""
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from msds.kws_engine import CustomKeywordEngine


class FastDtwTests(unittest.TestCase):
    @staticmethod
    def vectors(n, seed):
        rng = np.random.default_rng(seed)
        a = rng.normal(size=(n, 32)).astype(np.float32)
        a /= np.maximum(np.linalg.norm(a, axis=1, keepdims=True), 1e-6)
        return a

    def compare(self, n, m):
        a, b = self.vectors(n, n + 15), self.vectors(m, m + 100)
        with patch.dict(os.environ, {"MSDS_KWS_FAST_DTW": "0"}):
            baseline = CustomKeywordEngine._dtw_distance(a, b)
        with patch.dict(os.environ, {"MSDS_KWS_FAST_DTW": "1"}):
            accelerated = CustomKeywordEngine._dtw_distance(a, b)
        self.assertTrue(np.isfinite(baseline))
        self.assertTrue(np.isfinite(accelerated))
        self.assertLessEqual(abs(baseline - accelerated), 1e-5)
        return baseline, accelerated

    def test_unbalanced_phoneme_lengths(self):
        for shape in ((75, 110), (150, 72), (80, 80), (260, 200)):
            with self.subTest(shape=shape):
                self.compare(*shape)

    def test_duration_longer_than_cap_still_matches(self):
        self.compare(280, 270)

    def test_short_templates_use_exact_baseline(self):
        baseline, accelerated = self.compare(40, 65)
        self.assertEqual(baseline, accelerated)

    def test_identical_templates_have_near_perfect_similarity(self):
        a = self.vectors(120, 999)
        with patch.dict(os.environ, {"MSDS_KWS_FAST_DTW": "1"}):
            self.assertLess(CustomKeywordEngine._dtw_distance(a, a), 1e-6)

    def test_empty_input_still_rejected(self):
        a = self.vectors(80, 1)
        with patch.dict(os.environ, {"MSDS_KWS_FAST_DTW": "1"}):
            self.assertEqual(CustomKeywordEngine._dtw_distance(
                np.empty((0, 32), dtype=np.float32), a), float("inf"))

    def test_accelerator_is_off_without_opt_in(self):
        with patch.dict(os.environ, {"MSDS_KWS_FAST_DTW": "0"}), \
             patch.object(CustomKeywordEngine, "_dtw_distance_wavefront",
                          side_effect=AssertionError("unexpected opt-in path")):
            self.assertTrue(np.isfinite(CustomKeywordEngine._dtw_distance(
                self.vectors(90, 5), self.vectors(90, 6))))

    def test_short_templates_stay_legacy_even_when_accelerator_enabled(self):
        with patch.dict(os.environ, {"MSDS_KWS_FAST_DTW": "1"}), \
             patch.object(CustomKeywordEngine, "_dtw_distance_wavefront",
                          side_effect=AssertionError("short template optimized")):
            self.assertTrue(np.isfinite(CustomKeywordEngine._dtw_distance(
                self.vectors(40, 5), self.vectors(45, 6))))


if __name__ == "__main__":
    unittest.main()
