from __future__ import annotations

import math
import sys
import tempfile
import unittest
import wave
from pathlib import Path

import numpy as np

LOCAL_SERVER = Path(__file__).resolve().parents[1]
if str(LOCAL_SERVER) not in sys.path:
    sys.path.insert(0, str(LOCAL_SERVER))

from msds.kws_engine import CustomKeywordEngine, DEFAULT_KEYWORDS  # noqa: E402


def write_tone(path: Path, frequency: float, sample_rate: int = 8000, channels: int = 2) -> None:
    seconds = 0.55
    count = int(sample_rate * seconds)
    t = np.arange(count, dtype=np.float32) / sample_rate
    tone = 0.28 * np.sin(2.0 * math.pi * frequency * t)
    pcm = np.clip(tone * 32767.0, -32768, 32767).astype("<i2")
    if channels == 2:
        pcm = np.repeat(pcm[:, None], 2, axis=1).reshape(-1)
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(channels)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(pcm.tobytes())


class EnglishKwsScopeTests(unittest.TestCase):
    def test_tagalog_keyword_cannot_be_enrolled_on_scope_branch(self):
        with tempfile.TemporaryDirectory() as tmp:
            engine = CustomKeywordEngine(data_dir=str(Path(tmp) / "templates"))
            pcm = (np.sin(np.linspace(0, 50, 16000)) * 12000).astype("<i2").tobytes()
            with self.assertRaisesRegex(ValueError, "English-only thesis scope"):
                engine.enroll("tulong", pcm)

    def test_dataset_trainer_normalizes_wav_and_ignores_tagalog_folder(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            dataset = root / "dataset"
            output = root / "templates"

            for index, hz in enumerate((310, 330, 350), start=1):
                write_tone(dataset / "help" / f"help-{index}.wav", hz)
            for index, hz in enumerate((600, 650, 700, 750, 800), start=1):
                write_tone(dataset / "unknown" / f"unknown-{index}.wav", hz)
            write_tone(dataset / "tulong" / "tagalog.wav", 420)

            engine = CustomKeywordEngine(data_dir=str(output))
            report = engine.train_from_wav_dataset(dataset)

            self.assertTrue(report["success"])
            self.assertEqual(report["language_scope"], "en")
            self.assertIn("tulong", report["unsupported_folders"])
            self.assertEqual(report["classes"]["help"]["templates_written"], 3)
            self.assertEqual(report["classes"]["unknown"]["templates_written"], 5)
            self.assertIn("help", engine.status()["ready_keywords"])
            self.assertNotIn("tulong", engine.status()["keywords"])
            self.assertEqual(engine.status()["active_keywords"], list(DEFAULT_KEYWORDS))
            # Only a subset of the required English classes exists in this fixture.
            self.assertFalse(report["production_ready"])


if __name__ == "__main__":
    unittest.main()
