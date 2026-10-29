"""Check that CUDA installer survives network interruption without CPU fallback.

Static checks are intentionally offline; the 2.5 GB CUDA wheel is not
downloaded during this unit test.
"""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


class ResumableCudaInstallerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.helper = (ROOT / "install-cuda-torch.ps1").read_text(encoding="utf-8")
        cls.launcher = (ROOT / "setup-neural-kws.ps1").read_text(encoding="utf-8")

    def test_launcher_invokes_resumable_helper(self):
        self.assertIn('install-cuda-torch.ps1', self.launcher)
        self.assertIn('-PythonExe $venvPython', self.launcher)
        self.assertNotIn('pip install --timeout 120 --retries 10 --index-url "https://download.pytorch.org/whl/cu124" "torch==2.5.1"', self.launcher)

    def test_partial_download_persists(self):
        self.assertIn('.gpu-wheel-cache', self.helper)
        self.assertIn('$wheelPath.part', self.helper)
        self.assertIn('--continue-at -', self.helper)
        self.assertIn('--retry-all-errors', self.helper)
        self.assertIn('$partialPath', self.helper)
        self.assertIn('Move-Item -LiteralPath $partialPath -Destination $wheelPath', self.helper)
        self.assertIn('curl.exe', self.helper)

    def test_integrity_and_vendor_source(self):
        self.assertIn('z.testzip()', self.helper)
        self.assertIn('torch-2.5.1%2Bcu124-cp312-cp312-win_amd64.whl', self.helper)
        self.assertIn('download-r2.pytorch.org', self.helper)
        self.assertIn('torchaudio==2.5.1', self.helper)
        self.assertIn('--timeout 900 --retries 15', self.helper)

    def test_no_cpu_pytorch_fallback(self):
        self.assertNotIn('/whl/cpu', self.helper)
        self.assertNotIn('cpuonly', self.helper.lower())
        self.assertIn('MSDS_REQUIRE_CUDA = "1"', self.launcher)

    def test_cache_is_not_committed(self):
        ignored = (ROOT / ".gitignore").read_text(encoding="utf-8")
        self.assertIn('.gpu-wheel-cache/', ignored)


if __name__ == "__main__":
    unittest.main()
