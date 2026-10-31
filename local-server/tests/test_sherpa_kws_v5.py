"""No-audio, no-model tests for the isolated pretrained V5 benchmarking flow."""
from __future__ import annotations

from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from benchmark_sherpa_kws_v5 import (
    LABELS, SAMPLE_RATE, TAIL_SECONDS,
    model_inventory, score_events, spot_complete_clip, verify_test_wavs,
)
from prepare_neural_kws import MODEL_NAME, MODEL_STEMS


class FakeStream:
    def __init__(self):
        self.seen_audio = []
        self.finished = False
        self.decodes = 0


class FakeSpotter:
    def __init__(self, raw_result="FIRE"):
        self.raw_result = raw_result
        self.calls = []

    def create_stream(self):
        stream = FakeStream()
        self.calls.append(stream)
        return stream

    def is_ready(self, stream):
        return stream.decodes < 1

    def decode_stream(self, stream):
        stream.decodes += 1

    def get_result(self, stream):
        return self.raw_result

    def reset_stream(self, stream):
        stream.reset = True


class V5PretrainedTests(unittest.TestCase):
    def test_complete_clip_decodes_with_tail_new_stream_and_reset(self):
        fake = FakeSpotter()
        source = np.ones(SAMPLE_RATE * 2, np.float32) * 0.1
        frozen = source.copy()
        first = spot_complete_clip(fake, source)
        second = spot_complete_clip(fake, source)
        self.assertEqual(first["events"], ["fire"])
        self.assertEqual(second["events"], ["fire"])
        self.assertEqual(len(fake.calls), 2)
        self.assertIsNot(fake.calls[0], fake.calls[1])
        for stream in fake.calls:
            self.assertEqual(len(stream.seen_audio), 2)
            self.assertEqual(len(stream.seen_audio[1]), int(SAMPLE_RATE * TAIL_SECONDS))
            self.assertTrue(np.all(stream.seen_audio[1] == 0))
            self.assertTrue(stream.finished)
            self.assertTrue(stream.reset)
        np.testing.assert_array_equal(source, frozen)

    def test_unexpected_raw_keyword_is_rejected(self):
        fake = FakeSpotter("something unexpected")
        result = spot_complete_clip(fake, np.zeros(SAMPLE_RATE, np.float32))
        self.assertEqual(result["events"], [])
        self.assertEqual(result["ignored_raw_results"], 1)

    def test_reject_invalid_audio_or_tail(self):
        fake = FakeSpotter()
        with self.assertRaises(ValueError):
            spot_complete_clip(fake, np.array([np.nan], dtype=np.float32))
        with self.assertRaises(ValueError):
            spot_complete_clip(fake, np.ones(SAMPLE_RATE, np.float32), tail_seconds=0.0)

    def test_positive_recall_unknown_false_positives_and_wrong_word(self):
        rows = [
            {"expected": "fire", "events": ["fire"]},
            {"expected": "fire", "events": []},
            {"expected": "fire", "events": ["fire", "police"]},
            {"expected": "help", "events": ["fire"]},
            {"expected": "unknown", "events": []},
            {"expected": "unknown", "events": ["danger"]},
        ]
        for label in LABELS:
            if label not in {"fire", "help", "unknown"}:
                rows.append({"expected": label, "events": []})
        result = score_events(rows)
        self.assertEqual(result["positive_wavs"], 9)
        self.assertEqual(result["correctly_accepted_positive_wavs"], 1)
        self.assertEqual(result["unknown_false_positive_count"], 1)
        self.assertEqual(result["unknown_wavs"], 2)
        self.assertEqual(result["per_label"]["fire"]["accepted_correct"], 1)
        self.assertEqual(result["per_label"]["fire"]["multiple_events"], 1)
        self.assertEqual(result["per_label"]["help"]["wrong_keyword_events"], 1)
        self.assertEqual(result["per_label"]["unknown"]["accepted_correct"], 1)

    def test_model_inventory_checks_all_files_and_keyword_labels(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            for name in MODEL_STEMS:
                p = root / MODEL_NAME / name
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(b"not actual model; existence test only")
            keywords = root / "msds_keywords.txt"
            keywords.write_text(
                "".join(
                    f"WORD :1.0 #0.50 @{label}\n"
                    for label in LABELS if label != "unknown"
                ), encoding="utf-8"
            )
            info = model_inventory(root)
            self.assertEqual(set(info["keyword_labels"]), set(LABELS)-{"unknown"})
            self.assertEqual(info["preexisting_config"]["keyword_threshold"], 0.5)
            keywords.write_text("ABC :1.0 #0.50 @fire\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "exactly seven"):
                model_inventory(root)
            keywords.unlink()
            with self.assertRaises(FileNotFoundError):
                model_inventory(root)

    def test_test_wavs_prevent_train_duplicates_and_cross_test_reuse(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "neural-kws-data"
            separate = root / "new-experiment"
            for label in LABELS:
                folder = separate / "train" / label
                folder.mkdir(parents=True)
                (folder / f"{label}.wav").write_bytes(label.encode())
            with patch(
                "benchmark_sherpa_kws_v5.load_group_manifest",
                return_value=[{"sha256": "unused-digest"}],
            ):
                files, signature = verify_test_wavs(
                    root, root / "group_manifest_v3.csv", separate
                )
                self.assertEqual(len(files), len(LABELS))
                self.assertEqual(len(signature), 64)
                with self.assertRaisesRegex(ValueError, "conflicts"):
                    verify_test_wavs(root, root / "x.csv", root / "holdout")
                target = separate / "train" / "unknown" / "unknown.wav"
                target.write_bytes(b"help")
                with self.assertRaisesRegex(ValueError, "Duplicate audio"):
                    verify_test_wavs(root, root / "x.csv", separate)


# Emulate the only sherpa-onnx API the V5 script uses. No ONNX model required.
def fake_accept(self, sr, audio):
    self.seen_audio.append(np.asarray(audio).copy())


def fake_finished(self):
    self.finished = True


FakeStream.accept_waveform = fake_accept
FakeStream.input_finished = fake_finished

if __name__ == "__main__":
    unittest.main()
