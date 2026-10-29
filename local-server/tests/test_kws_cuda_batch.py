"""GPU batching regressions for the CUDA-required KWS experiment.

No enrollment files are edited. GPU numerical test skips when NVIDIA CUDA
is unavailable in the test runner, while dispatch test uses a mocked kernel.
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from msds.kws_engine import CustomKeywordEngine


class CudaBatchTests(unittest.TestCase):
    @staticmethod
    def features(n, seed):
        rng = np.random.default_rng(seed)
        a = rng.normal(size=(n, 32)).astype(np.float32)
        a /= np.maximum(np.linalg.norm(a, axis=1, keepdims=True), 1e-6)
        return a

    def test_one_batch_includes_positive_and_unknown_templates(self):
        with tempfile.TemporaryDirectory() as tmp:
            engine = CustomKeywordEngine(data_dir=tmp)
            feature = self.features(60, 2)
            engine.templates = {
                "help": [feature.copy() for _ in range(3)],
                "fire": [feature.copy() for _ in range(3)],
                "unknown": [feature.copy() for _ in range(5)],
            }
            fake_distances = np.array(
                [0.06] * 3 + [0.20] * 3 + [0.40] * 5,
                dtype=np.float32,
            )
            with patch.dict(os.environ, {"MSDS_REQUIRE_CUDA": "1"}), \
                 patch.object(engine, "extract_features", return_value=feature), \
                 patch.object(engine, "_dtw_distances_cuda_batched",
                              return_value=fake_distances) as gpu, \
                 patch.object(engine, "_dtw_distance",
                              side_effect=AssertionError("CPU loop was used")):
                decision = engine.diagnose(bytes(16000))
            gpu.assert_called_once()
            self.assertEqual(len(gpu.call_args.args[1]), 11)
            self.assertEqual(decision.keyword, "help")
            self.assertEqual(decision.negative_confidence, 0.60)
            self.assertEqual(decision.reason, "accepted")

    def test_cuda_unavailable_raises_instead_of_cpu_fallback(self):
        try:
            import torch
        except ImportError:
            self.skipTest("torch not installed in this interpreter")
        with patch.object(torch.cuda, "is_available", return_value=False):
            with self.assertRaisesRegex(RuntimeError, "GPU unavailable"):
                CustomKeywordEngine._dtw_distances_cuda_batched(
                    self.features(50, 3), [self.features(45, 4)],
                )

    def test_batch_matches_original_dtw_on_real_cuda(self):
        try:
            import torch
        except ImportError:
            self.skipTest("torch not installed")
        if not torch.cuda.is_available():
            self.skipTest("CUDA is required for actual GPU parity test")
        query = self.features(90, 10)
        templates = [self.features(m, 20 + i) for i, m in
                     enumerate((30, 70, 90, 140, 210, 260))]
        expected = np.array([
            CustomKeywordEngine._dtw_distance_wavefront(query, item)
            for item in templates
        ])
        actual = CustomKeywordEngine._dtw_distances_cuda_batched(query, templates)
        np.testing.assert_allclose(actual, expected, rtol=0, atol=1e-5)

    def test_padding_and_empty_templates_do_not_create_false_matches(self):
        try:
            import torch
        except ImportError:
            self.skipTest("torch not installed")
        if not torch.cuda.is_available():
            self.skipTest("CUDA is required for actual GPU parity test")
        query = self.features(40, 5)
        samples = [np.empty((0, 32), np.float32),
                   self.features(10, 6), self.features(70, 7)]
        scores = CustomKeywordEngine._dtw_distances_cuda_batched(query, samples)
        self.assertTrue(np.isinf(scores[0]))
        self.assertTrue(np.isfinite(scores[1]))
        self.assertTrue(np.isfinite(scores[2]))


if __name__ == "__main__":
    unittest.main()
