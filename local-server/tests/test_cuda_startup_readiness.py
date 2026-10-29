"""CUDA cold-start readiness: inspect Electron timeout policy offline."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]


class CudaStartupReadinessTests(unittest.TestCase):
    def test_cuda_gets_bounded_longer_startup_budget(self):
        script = (ROOT / "electron" / "localServer.cjs").read_text(
            encoding="utf-8"
        )
        self.assertIn("env.MSDS_REQUIRE_CUDA === '1' ? 180000 : 30000", script)
        self.assertIn("const readyBudgetMs = cameraReadyBudgetMs()", script)
        self.assertIn("waitForReady(readyBudgetMs)", script)

    def test_cpu_timeouts_unchanged(self):
        script = (ROOT / "electron" / "localServer.cjs").read_text(
            encoding="utf-8"
        )
        self.assertIn("return env.MSDS_REQUIRE_CUDA === '1' ? 180000 : 30000", script)


if __name__ == "__main__":
    unittest.main()
