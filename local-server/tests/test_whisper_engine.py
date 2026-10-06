"""Tests for SYSTRAN/faster-whisper backend selection and filters."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import msds.whisper_engine as whisper_engine


class FasterWhisperBackendTests(unittest.TestCase):
    def test_auto_prefers_cuda_then_cpu(self):
        with patch.object(whisper_engine, "WHISPER_DEVICE", "auto"), \
             patch.object(whisper_engine, "WHISPER_COMPUTE_TYPE", ""):
            engine = whisper_engine.WhisperEngine()
            self.assertEqual(
                engine._backend_candidates(),
                [("cuda", "int8_float16"), ("cpu", "int8")],
            )

    def test_cpu_mode_uses_int8(self):
        with patch.object(whisper_engine, "WHISPER_DEVICE", "cpu"), \
             patch.object(whisper_engine, "WHISPER_COMPUTE_TYPE", ""):
            engine = whisper_engine.WhisperEngine()
            self.assertEqual(engine._backend_candidates(), [("cpu", "int8")])

    def test_cuda_mode_uses_int8_float16(self):
        with patch.object(whisper_engine, "WHISPER_DEVICE", "cuda"), \
             patch.object(whisper_engine, "WHISPER_COMPUTE_TYPE", ""):
            engine = whisper_engine.WhisperEngine()
            self.assertEqual(engine._backend_candidates(), [("cuda", "int8_float16")])

    def test_explicit_compute_type_is_respected(self):
        with patch.object(whisper_engine, "WHISPER_DEVICE", "cuda"), \
             patch.object(whisper_engine, "WHISPER_COMPUTE_TYPE", "float16"):
            engine = whisper_engine.WhisperEngine()
            self.assertEqual(engine._backend_candidates(), [("cuda", "float16")])

    def test_safety_words_are_not_filtered_as_hallucinations(self):
        for phrase in ("help", "tulong", "sunog", "saklolo"):
            with self.subTest(phrase=phrase):
                self.assertFalse(whisper_engine.is_hallucination(phrase))


if __name__ == "__main__":
    unittest.main()
