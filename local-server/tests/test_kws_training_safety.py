"""Regression tests for CCTV speech collection and non-destructive training."""
from __future__ import annotations

import io
import json
import math
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import collect_english_kws as collect  # noqa: E402
import train_english_kws as training  # noqa: E402
from msds.kws_engine import SAMPLE_RATE  # noqa: E402


def block(level: float, frequency: int = 380) -> bytes:
    count = SAMPLE_RATE // 10
    times = np.arange(count, dtype=np.float32) / SAMPLE_RATE
    audio = level * np.sin(2 * math.pi * frequency * times)
    return (audio * 32767).astype("<i2").tobytes()


class TrainingSafetyTests(unittest.TestCase):
    def test_vad_extracts_one_complete_cctv_utterance(self):
        frames = [block(0.0)] * 5 + [block(0.25)] * 7 + [block(0.0)] * 5
        phrase = collect.extract_utterance(frames)
        self.assertIsNotNone(phrase)
        self.assertGreaterEqual(len(phrase), int(.30 * 2 * SAMPLE_RATE))
        collect.check_quality(phrase)
        self.assertIsNone(collect.extract_utterance([block(0.0)] * 20))

    def test_energy_gate_rejects_bad_clips(self):
        with self.assertRaisesRegex(ValueError, "quiet"):
            collect.check_quality(bytes(SAMPLE_RATE))
        with self.assertRaisesRegex(ValueError, "distorted"):
            collect.check_quality(np.full(12000, 32767, dtype="<i2").tobytes())
        with self.assertRaisesRegex(ValueError, "length"):
            collect.check_quality(block(0.25))

    def test_camera_uses_only_local_restream_without_rtsp_password(self):
        status = {
            "ffmpeg_path": sys.executable,
            "cameras": [{"id": "slot-1", "ffmpeg": True, "path": "cam1",
                         "rtsp": "rtsp://admin:secret@192.168.0.2/private"}],
        }
        fake = io.BytesIO(json.dumps(status).encode())
        with patch("urllib.request.urlopen", return_value=fake):
            exe, url = collect.camera_source("slot-1")
        self.assertEqual(exe, sys.executable)
        self.assertEqual(url, f"rtsp://127.0.0.1:{collect.RTSP_PORT}/cam1")
        self.assertNotIn("secret", url)

    def test_verifiable_backup_does_not_delete_original_templates(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "current"
            (source / "help").mkdir(parents=True)
            original = source / "help" / "one.npy"
            original.write_bytes(b"original-model-template")
            archive = training.backup_templates(source, Path(root) / "backups")
            self.assertTrue(archive.is_file())
            self.assertEqual(original.read_bytes(), b"original-model-template")
            with zipfile.ZipFile(archive) as saved:
                self.assertEqual(saved.read("help/one.npy"), original.read_bytes())
                self.assertEqual(json.loads(saved.read("backup_info.json"))["template_count"], 1)

    def test_candidate_install_replaces_model_only_after_explicit_call(self):
        with tempfile.TemporaryDirectory() as root:
            base = Path(root)
            active = base / "live"
            candidate = base / "candidate"
            (active / "help").mkdir(parents=True)
            (candidate / "fire").mkdir(parents=True)
            (active / "help" / "old.npy").write_bytes(b"OLD")
            (candidate / "fire" / "new.npy").write_bytes(b"NEW")
            # Merely making a candidate does not touch live templates.
            self.assertEqual((active / "help" / "old.npy").read_bytes(), b"OLD")
            training.install_candidate(candidate, active)
            self.assertFalse((active / "help" / "old.npy").exists())
            self.assertEqual((active / "fire" / "new.npy").read_bytes(), b"NEW")

    def test_insufficient_coverage_never_passes_predeployment_gate(self):
        report = {"classes": {"help": {"templates_written": 3},
                              "unknown": {"templates_written": 5}}}
        coverage = training.training_coverage(report)
        self.assertFalse(all(x["recordings"] >= x["minimum"] for x in coverage.values()))
        self.assertEqual(coverage["help"]["minimum"], 5)
        self.assertEqual(coverage["unknown"]["minimum"], 10)


if __name__ == "__main__":
    unittest.main()
