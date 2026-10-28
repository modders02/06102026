"""Neural KWS integration regressions; external models are mocked, not downloaded."""
import os
import sys
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from msds import neural_kws_trial
from msds.camera import Camera
from msds.kws_engine import KWS_ENGINE


class FakeStream:
    def __init__(self):
        self.audio = []
        self.finished = False

    def accept_waveform(self, rate, samples):
        assert rate == 16000
        self.audio.append(np.asarray(samples))

    def input_finished(self):
        self.finished = True


class FakeSpotter:
    def __init__(self, word="HELP"):
        self.word = word
        self.stream = None
        self.decode_count = 0

    def create_stream(self):
        self.stream = FakeStream()
        return self.stream

    def is_ready(self, stream):
        return self.decode_count == 0

    def decode_stream(self, stream):
        self.decode_count += 1

    def get_result(self, stream):
        return self.word


def accepted_help():
    return SimpleNamespace(
        keyword="help", confidence=0.94, distance=0.06,
        runner_up_keyword="ambulance", runner_up_confidence=0.60,
        keyword_scores={"help": 0.94, "ambulance": 0.60},
        keyword_duration_ratios={"help": 1.0, "ambulance": 0.80},
        class_margin=0.34, required_margin=0.02,
        negative_confidence=0.2, negative_second_confidence=0.1,
        negative_mean2_confidence=0.15,
        negative_top_confidences=[0.2, 0.1, 0.05],
        duration_ratio=1.0, duration_ms=600,
        accepted=True, reason="accepted",
    )


class NeuralKwsTrialTests(unittest.TestCase):
    def setUp(self):
        self.pcm = b"\x01\x00" * 16000

    def test_off_requires_no_extra_dependency(self):
        with patch.dict(os.environ, {"MSDS_KWS_NEURAL_MODE": "off"}):
            self.assertEqual(neural_kws_trial.neural_mode(), "off")

    def test_unknown_mode_never_enables_neural_verification(self):
        with patch.dict(os.environ, {"MSDS_KWS_NEURAL_MODE": "verify-me"}):
            self.assertEqual(neural_kws_trial.neural_mode(), "off")

    def test_deepfilternet_three_and_four_value_init_contracts(self):
        model, state = object(), object()
        self.assertEqual(
            neural_kws_trial._df_model_and_state((model, state, "DF3", 100)),
            (model, state),
        )
        self.assertEqual(
            neural_kws_trial._df_model_and_state((model, state, "DF3")),
            (model, state),
        )
        with self.assertRaisesRegex(RuntimeError, "model and state"):
            neural_kws_trial._df_model_and_state((model,))

    def test_installer_includes_sherpa_sentencepiece_dependency(self):
        installer = (
            Path(__file__).resolve().parents[1] / "setup-neural-kws.ps1"
        ).read_text(encoding="utf-8")
        self.assertIn("deepfilternet sherpa-onnx scipy sentencepiece pypinyin", installer)
        self.assertIn("import sentencepiece, pypinyin", installer)
        self.assertIn("HELP @HELP", installer)
        self.assertIn("AMBULANCE @AMBULANCE", installer)


    def test_exact_english_word_only_and_padding(self):
        for spoken, expected in [("HELP", "help"), ("AMBULANCE", "ambulance"),
                                 ("HELP ME", ""), ("HELLO", "")]:
            engine = FakeSpotter(spoken)
            with patch.dict(os.environ, {"MSDS_KWS_NEURAL_DENOISE": "0"}), \
                 patch.object(neural_kws_trial, "_load_spotter", return_value=engine):
                result = neural_kws_trial.detect_keyword(self.pcm)
            self.assertEqual(result.keyword, expected)
            self.assertEqual(result.error, "")
            self.assertFalse(result.enhanced)
            self.assertTrue(engine.stream.finished)
            self.assertEqual(len(engine.stream.audio), 2)
            self.assertEqual(len(engine.stream.audio[1]), 12000)

    def test_unavailable_model_fails_closed(self):
        with patch.dict(os.environ, {"MSDS_KWS_NEURAL_DENOISE": "0"}), \
             patch.object(neural_kws_trial, "_load_spotter", side_effect=RuntimeError("missing model")):
            result = neural_kws_trial.detect_keyword(self.pcm)
        self.assertEqual(result.keyword, "")
        self.assertIn("missing model", result.error)

    def test_too_short_or_broken_pcm_is_not_a_keyword(self):
        self.assertEqual(neural_kws_trial.detect_keyword(b"abc").error, "invalid_segment")
        self.assertEqual(neural_kws_trial.detect_keyword(b"\0\0" * 50).keyword, "")

    def test_shadow_mode_does_not_block_original_accepted_dtw(self):
        camera = Camera(id="slot-1", path="cam1", name="test", rtsp="rtsp://example")
        completed = threading.Event()

        def evaluate(segment):
            completed.set()
            return neural_kws_trial.NeuralObservation("ambulance", 4.0, True)

        with patch.dict(os.environ, {"MSDS_KWS_NEURAL_MODE": "shadow"}), \
             patch.object(KWS_ENGINE, "has_ready_templates", return_value=True), \
             patch.object(camera.kws_segmenter, "feed", return_value=[self.pcm]), \
             patch.object(KWS_ENGINE, "diagnose", return_value=accepted_help()), \
             patch("msds.camera.detect_keyword", side_effect=evaluate):
            camera._process_custom_kws_pcm(self.pcm)
            self.assertTrue(completed.wait(2))
        self.assertEqual(camera.events[0]["keyword"], "help")
        self.assertEqual(camera.kws_last_decision, "accepted")

    def test_verify_mode_blocks_disagreement(self):
        camera = Camera(id="slot-1", path="cam1", name="test", rtsp="rtsp://example")
        with patch.dict(os.environ, {"MSDS_KWS_NEURAL_MODE": "verify"}), \
             patch.object(KWS_ENGINE, "has_ready_templates", return_value=True), \
             patch.object(camera.kws_segmenter, "feed", return_value=[self.pcm]), \
             patch.object(KWS_ENGINE, "diagnose", return_value=accepted_help()), \
             patch("msds.camera.detect_keyword",
                   return_value=neural_kws_trial.NeuralObservation("ambulance", 4, True)):
            camera._process_custom_kws_pcm(self.pcm)
        self.assertEqual(camera.events, [])
        self.assertEqual(camera.kws_last_decision, "neural_disagreement")

    def test_verify_mode_blocks_missing_neural_model(self):
        camera = Camera(id="slot-1", path="cam1", name="test", rtsp="rtsp://example")
        with patch.dict(os.environ, {"MSDS_KWS_NEURAL_MODE": "verify"}), \
             patch.object(KWS_ENGINE, "has_ready_templates", return_value=True), \
             patch.object(camera.kws_segmenter, "feed", return_value=[self.pcm]), \
             patch.object(KWS_ENGINE, "diagnose", return_value=accepted_help()), \
             patch("msds.camera.detect_keyword",
                   return_value=neural_kws_trial.NeuralObservation("", 5, False, "missing model")):
            camera._process_custom_kws_pcm(self.pcm)
        self.assertEqual(camera.events, [])
        self.assertEqual(camera.kws_last_decision, "neural_unavailable")

    def test_verify_mode_matches_before_existing_voice_visual_gate(self):
        camera = Camera(id="slot-1", path="cam1", name="test", rtsp="rtsp://example")
        with patch.dict(os.environ, {"MSDS_KWS_NEURAL_MODE": "verify"}), \
             patch.object(KWS_ENGINE, "has_ready_templates", return_value=True), \
             patch.object(camera.kws_segmenter, "feed", return_value=[self.pcm]), \
             patch.object(KWS_ENGINE, "diagnose", return_value=accepted_help()), \
             patch("msds.camera.detect_keyword",
                   return_value=neural_kws_trial.NeuralObservation("help", 5, True)):
            camera._process_custom_kws_pcm(self.pcm)
        self.assertEqual([e["keyword"] for e in camera.events], ["help"])


if __name__ == "__main__":
    unittest.main()
