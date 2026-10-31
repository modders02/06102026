"""Frozen-V3 regression checks without microphone, model downloads or CCTV."""
from __future__ import annotations

import csv
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
import wave

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from evaluate_noise_kws_v3_frozen import (
    enumerate_evaluation_wavs, evaluate_frozen_v3, gated_prediction,
    summarize, verify_frozen_v3,
)
from noise_kws_v3_groups import (
    load_group_manifest, refresh_group_manifest, split_grouped,
)
from train_noise_kws_v3 import HIDDEN_V3, MODEL_VERSION, save_v3
from train_noise_augmented_kws import DIM, LABELS, SAMPLE_RATE


def make_wav(path: Path, freq: float) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    t = np.arange(SAMPLE_RATE, dtype=np.float32) / SAMPLE_RATE
    samples = (np.sin(2*np.pi*freq*t)*9000).astype("<i2")
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(samples.tobytes())


def example_corpus(base: Path):
    root = base / "neural-kws-data"
    for j, person in enumerate(("a", "b")):
        for i, label in enumerate(LABELS):
            make_wav(root / "train" / label / f"{person}_{label}.wav",
                     230 + i*23 + j*51)
    manifest = root / "group_manifest_v3.csv"
    refresh_group_manifest(root, manifest)
    with manifest.open("r", encoding="utf-8", newline="") as f:
        entries = list(csv.DictReader(f))
    for entry in entries:
        entry["speaker_id"] = "voice_a" if "/a_" in entry["relative_path"] else "voice_b"
        entry["session_id"] = "session_one"
    with manifest.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=entries[0].keys())
        writer.writeheader()
        writer.writerows(entries)
    train, val, _ = split_grouped(
        load_group_manifest(root, manifest), group_by="speaker", seed=42
    )
    info = {
        "version": MODEL_VERSION,
        "labels": LABELS,
        "group_by": "speaker",
        "seed": 42,
        "accept_threshold": 0.80,
        "accept_margin": 0.15,
        "shadow_only": True,
        "live_alerts_authorized": False,
    }
    weights = {
        "mean": np.zeros(DIM, np.float32),
        "scale": np.ones(DIM, np.float32),
        "w1": np.zeros((DIM, HIDDEN_V3), np.float32),
        "b1": np.zeros(HIDDEN_V3, np.float32),
        "w2": np.zeros((HIDDEN_V3, len(LABELS)), np.float32),
        "b2": np.zeros(len(LABELS), np.float32),
    }
    candidate = root / "artifacts" / "noise_augmented_shadow_v3.npz"
    save_v3(candidate, weights, info)
    candidate.with_suffix(".report.json").write_text(json.dumps({
        "model_metadata": info,
        "dataset": {
            "train_original_files": len(train),
            "validation_file_manifest_sha256": hashlib.sha256(
                "\n".join(sorted(x["relative_path"] for x in val)).encode()
            ).hexdigest(),
        },
    }), encoding="utf-8")
    test = root / "independent-v41-test-20261101"
    for i, label in enumerate(LABELS):
        make_wav(test / "train" / label / "fresh.wav", 700 + i*27)
    return root, manifest, candidate, test


class V3RefinementTests(unittest.TestCase):
    def test_frozen_checkpoint_checks_hash_and_group_membership(self):
        with tempfile.TemporaryDirectory() as d:
            root, manifest, checkpoint, test = example_corpus(Path(d))
            weights, provenance = verify_frozen_v3(root, manifest, checkpoint)
            self.assertEqual(len(weights["b2"]), len(LABELS))
            self.assertTrue(provenance["speaker_disjoint_on_original_validation"])
            self.assertEqual(provenance["original_train_source_wavs"], 8)
            meta = json.loads(checkpoint.with_suffix(".report.json").read_text())
            meta["dataset"]["validation_file_manifest_sha256"] = "deadbeef"
            checkpoint.with_suffix(".report.json").write_text(json.dumps(meta))
            with self.assertRaisesRegex(ValueError, "membership"):
                verify_frozen_v3(root, manifest, checkpoint)

    def test_rejects_train_holdout_and_identical_test_recordings(self):
        with tempfile.TemporaryDirectory() as d:
            root, manifest, checkpoint, test = example_corpus(Path(d))
            _, meta = verify_frozen_v3(root, manifest, checkpoint)
            original_hashes = meta["training_sha256"]
            paths, fingerprint = enumerate_evaluation_wavs(root, test, original_hashes)
            self.assertEqual(len(paths), 8)
            self.assertEqual(len(fingerprint), 64)
            with self.assertRaisesRegex(ValueError, "original training"):
                enumerate_evaluation_wavs(root, root, original_hashes)
            with self.assertRaisesRegex(ValueError, "original training"):
                enumerate_evaluation_wavs(root, root / "holdout", original_hashes)
            dup = test / "train" / "police" / "fresh.wav"
            dup.write_bytes((test / "train" / "help" / "fresh.wav").read_bytes())
            with self.assertRaisesRegex(ValueError, "Repeated WAV"):
                enumerate_evaluation_wavs(root, test, original_hashes)

    def test_refuses_recycled_training_wavs(self):
        with tempfile.TemporaryDirectory() as d:
            root, manifest, checkpoint, test = example_corpus(Path(d))
            _, meta = verify_frozen_v3(root, manifest, checkpoint)
            original_file = root / "train" / "help" / "a_help.wav"
            target_file = test / "train" / "help" / "fresh.wav"
            target_file.write_bytes(original_file.read_bytes())
            with self.assertRaisesRegex(ValueError, "duplicates V3"):
                enumerate_evaluation_wavs(root, test, meta["training_sha256"])

    def test_fixed_gate_does_not_lower_threshold_or_guess_label(self):
        probs = np.zeros(len(LABELS), np.float32)
        probs[LABELS.index("fire")] = 0.79
        probs[LABELS.index("help")] = 0.21
        state = gated_prediction(probs)
        self.assertEqual(state["raw_top_class"], "fire")
        self.assertEqual(state["gated_prediction"], "unknown")
        self.assertEqual(state["gate_reason"], "below_fixed_threshold")
        probs[LABELS.index("fire")] = 0.81
        probs[LABELS.index("help")] = 0.19
        state = gated_prediction(probs)
        self.assertEqual(state["gated_prediction"], "fire")
        self.assertEqual(state["gate_reason"], "accepted")
        probs[:] = 0
        probs[LABELS.index("unknown")] = 0.95
        probs[LABELS.index("help")] = 0.05
        self.assertEqual(gated_prediction(probs)["gated_prediction"], "unknown")

    def test_per_label_recall_and_false_positive(self):
        rows = []
        for label in LABELS:
            rows.append({
                "expected": label,
                "raw_top_class": label,
                "gated_prediction": label,
                "gate_reason": "accepted" if label != "unknown" else "top_class_unknown",
            })
        info = summarize(rows)
        self.assertEqual(info["positive_wavs"], 7)
        self.assertEqual(info["unknown_wavs"], 1)
        self.assertEqual(info["fixed_gate_positive_recall"], 1.0)
        self.assertEqual(info["unknown_false_positive_count"], 0)
        rows[-1]["raw_top_class"] = "fire"
        rows[-1]["gated_prediction"] = "fire"
        info = summarize(rows)
        self.assertEqual(info["unknown_false_positive_count"], 1)
        self.assertEqual(info["per_label"]["unknown"]["accepted_correct"], 0)

    def test_check_mode_uses_original_model_without_decoding(self):
        with tempfile.TemporaryDirectory() as d:
            root, manifest, candidate, test = example_corpus(Path(d))
            result = evaluate_frozen_v3(root, manifest, candidate, test, decode=False)
            self.assertEqual(result["test_recording_count"], 8)
            self.assertFalse(result["retraining_performed"])
            self.assertFalse(result["thresholds_tuned"])
            self.assertFalse(result["operational_alerts_changed"])
            self.assertFalse(result["legacy_holdout_used"])
            self.assertNotIn("per_file", result)
            self.assertFalse((root / "artifacts" /
                              "noise_augmented_shadow_v3.frozen-new-recordings.json").exists())


if __name__ == "__main__":
    unittest.main()
