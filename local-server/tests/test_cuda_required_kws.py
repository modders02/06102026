"""Static and mocked CUDA-only invariants; no NVIDIA GPU required to run."""
from pathlib import Path
import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from msds import neural_kws_trial
from msds.kws_engine import CustomKeywordEngine
import numpy as np

ROOT = Path(__file__).resolve().parents[1]


class RequiredCudaTests(unittest.TestCase):
    def test_cuda_requirement_refuses_cpu(self):
        import torch
        with patch.object(torch.cuda, "is_available", return_value=False):
            with self.assertRaisesRegex(RuntimeError, "NVIDIA GPU"):
                neural_kws_trial.require_cuda()

    def test_keyword_spotter_cannot_use_cpu_provider(self):
        source = (ROOT / "msds" / "neural_kws_trial.py").read_text(encoding="utf8")
        self.assertIn('provider="cuda"', source)
        self.assertNotIn('provider="cpu"', source)
        self.assertIn('actual_device.type != "cuda"', source)

    def test_launcher_has_no_cpu_install_or_gpu_toggle(self):
        script = (ROOT / "setup-neural-kws.ps1").read_text(encoding="utf8")
        self.assertIn('.gpu-venv', script)
        self.assertIn('MSDS_REQUIRE_CUDA = "1"', script)
        self.assertIn('https://download.pytorch.org/whl/cu124', script)
        self.assertIn('sherpa-onnx==2.0.1+cuda12.cudnn9', script)
        self.assertNotIn('https://download.pytorch.org/whl/cpu', script)
        self.assertNotIn('[switch]$FastDtw', script)

    def test_service_requires_gpu_independently_of_launcher(self):
        source = (ROOT / "camera_server.py").read_text(encoding="utf8")
        self.assertIn('os.environ["MSDS_REQUIRE_CUDA"] = "1"', source)
        self.assertIn('_gpu_name = require_cuda()', source)

    def test_cuda_dispatch_never_falls_back_to_cpu(self):
        a = np.ones((82, 32), np.float32) / np.sqrt(32)
        b = np.ones((85, 32), np.float32) / np.sqrt(32)
        with patch.dict(os.environ, {"MSDS_REQUIRE_CUDA": "1"}), \
             patch.object(CustomKeywordEngine, "_dtw_distance_cuda", return_value=0.123) as gpu, \
             patch.object(CustomKeywordEngine, "_dtw_distance_wavefront",
                          side_effect=AssertionError("unexpected CPU wavefront")):
            result = CustomKeywordEngine._dtw_distance(a, b)
        self.assertEqual(result, 0.123)
        gpu.assert_called_once()

    def test_cuda_failure_propagates_instead_of_cpu_fallback(self):
        a = np.ones((85, 32), np.float32) / np.sqrt(32)
        with patch.dict(os.environ, {"MSDS_REQUIRE_CUDA": "1"}), \
             patch.object(CustomKeywordEngine, "_dtw_distance_cuda",
                          side_effect=RuntimeError("CUDA unavailable")):
            with self.assertRaisesRegex(RuntimeError, "CUDA unavailable"):
                CustomKeywordEngine._dtw_distance(a, a)


if __name__ == "__main__":
    unittest.main()
