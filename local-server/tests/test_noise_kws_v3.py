"""Isolated V3 KWS verification: no camera and no external models needed."""
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

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
from noise_kws_v3_groups import (
    load_group_manifest, refresh_group_manifest, split_grouped,
)
from diagnose_noise_kws_v3 import decision_from_probabilities, diagnose, summarize
from train_noise_kws_v3 import (
    HIDDEN_V3, MODEL_VERSION, assemble_train_validation, balanced_ids,
    get_feature_engine, load_v3, save_v3, train_v3,
)
from train_noise_augmented_kws import DIM, LABELS, SAMPLE_RATE
from capture_noise_kws_wavs import destination


def wav(path: Path, freq: float = 320.0, duration: float = 1.0):
    path.parent.mkdir(parents=True, exist_ok=True)
    t = np.arange(int(SAMPLE_RATE * duration), dtype=np.float32) / SAMPLE_RATE
    audio = (0.12 * np.sin(2 * np.pi * freq * t)).astype(np.float32)
    with wave.open(str(path), "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(SAMPLE_RATE)
        f.writeframes((audio * 32767).astype("<i2").tobytes())


def make_group_corpus(root: Path, *, speakers=("voice_A", "voice_B")):
    for j, speaker in enumerate(speakers):
        for i, label in enumerate(LABELS):
            wav(root / "train" / label / f"{speaker}-{label}.wav",
                260 + 31 * i + 40 * j)
    for i in range(3):
        wav(root / "noise" / f"fan-{i}.wav", 75 + 10 * i, 3.0)
    manifest = root / "group_manifest_v3.csv"
    info = refresh_group_manifest(root, manifest)
    assert info["new_unassigned_files"] == len(speakers) * len(LABELS)
    with manifest.open("r", encoding="utf-8", newline="") as f:
        rows = list(csv.DictReader(f))
    for row in rows:
        row["speaker_id"] = row["relative_path"].split("/")[-1].split("-")[0] + "_" + row["relative_path"].split("/")[-1].split("-")[1]
        # Name is voice_A/voice_B; assign the same anonymized ID across words.
        row["speaker_id"] = "voice_A" if "voice_A-" in row["relative_path"] else "voice_B"
        row["session_id"] = "day_1"
    with manifest.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=("relative_path", "speaker_id", "session_id", "sha256"))
        writer.writeheader()
        writer.writerows(rows)
    return manifest


class KwsV3Tests(unittest.TestCase):
    def test_manifest_requires_authentic_group_labels_and_sha_fingerprint(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            wav(root / "train" / "help" / "x.wav")
            manifest = root / "group_manifest_v3.csv"
            status = refresh_group_manifest(root, manifest)
            self.assertEqual(status["training_files"], 1)
            self.assertEqual(status["unassigned_total"], 1)
            with self.assertRaisesRegex(ValueError, "Assign anonymized"):
                load_group_manifest(root, manifest)
            with manifest.open("r", encoding="utf-8", newline="") as f:
                rows = list(csv.DictReader(f))
            rows[0]["speaker_id"] = "speaker_1"
            rows[0]["session_id"] = "session_1"
            with manifest.open("w", encoding="utf-8", newline="") as f:
                w = csv.DictWriter(f, fieldnames=rows[0].keys())
                w.writeheader()
                w.writerows(rows)
            self.assertEqual(load_group_manifest(root, manifest)[0]["speaker_id"], "speaker_1")
            wav(root / "train" / "help" / "x.wav", freq=410)
            with self.assertRaisesRegex(ValueError, "WAV changed"):
                load_group_manifest(root, manifest)

    def test_group_split_blocks_single_speaker_and_prevents_leakage(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest = make_group_corpus(root)
            rows = load_group_manifest(root, manifest)
            x, v, detail = split_grouped(rows, group_by="speaker", seed=42)
            self.assertEqual(len(x), 8)
            self.assertEqual(len(v), 8)
            self.assertTrue(detail["speaker_disjoint"])
            self.assertEqual(detail["speaker_overlap_count"], 0)
            self.assertFalse(set(r["relative_path"] for r in x)
                             & set(r["relative_path"] for r in v))
            with self.assertRaisesRegex(ValueError, "TWO separate speaker"):
                split_grouped([r for r in rows if r["speaker_id"] == "voice_A"],
                              group_by="speaker")

    def test_same_speaker_session_mode_reports_leakage(self):
        rows = []
        for session in ("morning", "evening"):
            for label in LABELS:
                rows.append({
                    "relative_path": f"train/{label}/{session}.wav",
                    "speaker_id": "same_speaker",
                    "session_id": session, "label": label,
                })
        x, v, status = split_grouped(rows, group_by="session", seed=7)
        self.assertEqual(len(x), 8)
        self.assertEqual(len(v), 8)
        self.assertFalse(status["speaker_disjoint"])
        self.assertEqual(status["speaker_overlap_count"], 1)
        self.assertIn("Same speaker", status["session_only_warning"])
        with self.assertRaisesRegex(ValueError, "TWO separate speaker"):
            split_grouped(rows, group_by="speaker")

    def test_v3_augments_train_only_and_keeps_legacy_holdout_untouched(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest = make_group_corpus(root)
            rows = load_group_manifest(root, manifest)
            train, val, _ = split_grouped(rows, group_by="speaker")
            # Completely invalid old holdout: code MUST NOT inspect it.
            invalid = root / "holdout" / "help" / "never-open-this.wav"
            invalid.parent.mkdir(parents=True, exist_ok=True)
            invalid.write_bytes(b"NOT A WAV")
            engine = get_feature_engine(root)
            x, y, vx, vy, summary = assemble_train_validation(
                root, train, val, engine, variants=1, seed=42
            )
            self.assertEqual(len(x), 8 * 2 + 9)
            self.assertEqual(len(vx), 8)
            self.assertEqual(len(vy), 8)
            self.assertEqual(summary["validation_augmentations"], 0)
            self.assertTrue(invalid.exists())
            self.assertEqual(invalid.read_bytes(), b"NOT A WAV")
            self.assertEqual(set(y), set(range(len(LABELS))))
            self.assertEqual(set(vy), set(range(len(LABELS))))

    def test_balanced_batches_early_stopping_and_separate_v3_artifact(self):
        rng = np.random.default_rng(30)
        y = np.repeat(np.arange(len(LABELS)), 5)
        x = rng.normal(size=(len(y), DIM)).astype(np.float32)
        vy = np.arange(len(LABELS))
        vx = rng.normal(size=(len(vy), DIM)).astype(np.float32)
        ids = balanced_ids(y, np.random.default_rng(8), per_class=3)
        self.assertEqual(len(ids), 24)
        self.assertEqual(np.bincount(y[ids]).tolist(), [3] * len(LABELS))
        w, result = train_v3(
            x, y, vx, vy, seed=44, epochs=7, patience=3
        )
        self.assertLessEqual(result["best_epoch"], result["epochs_ran"])
        self.assertLessEqual(result["epochs_ran"], 7)
        self.assertEqual(w["w1"].shape, (DIM, HIDDEN_V3))
        self.assertTrue(np.isfinite(w["w1"]).all())
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            artifact = root / "artifacts" / "noise_augmented_shadow_v3.npz"
            save_v3(artifact, w, {"version": MODEL_VERSION, "labels": LABELS})
            loaded, metadata = load_v3(artifact)
            self.assertEqual(metadata["version"], MODEL_VERSION)
            np.testing.assert_array_equal(loaded["w2"], w["w2"])
            self.assertFalse((root / "artifacts" / "noise_augmented_shadow.npz").exists())

    def test_v3_diagnostic_separates_raw_class_from_fixed_gate(self):
        # These are synthetic outputs of the saved softmax, not trained WAVs.
        accepted = np.array([0.86, 0.02, 0.01, 0.01, 0.01, 0.01, 0.02, 0.06])
        strong = decision_from_probabilities(accepted, LABELS[0])
        self.assertEqual(strong["decision_reason"], "accepted")
        self.assertTrue(strong["accepted_correctly"])
        self.assertEqual(strong["raw_top_class"], LABELS[0])
        rejected = np.array([0.42, 0.12, 0.08, 0.08, 0.06, 0.05, 0.04, 0.15])
        weak = decision_from_probabilities(rejected, LABELS[0])
        self.assertEqual(weak["decision_reason"], "below_fixed_threshold")
        self.assertTrue(weak["raw_top_matches_label"])
        self.assertEqual(weak["predicted_after_safety_gate"], "unknown")
        other = np.array([0.02, 0.01, 0.01, 0.01, 0.01, 0.02, 0.02, 0.90])
        unknown = decision_from_probabilities(other, LABELS[0])
        self.assertEqual(unknown["decision_reason"], "top_class_unknown")
        self.assertFalse(unknown["raw_top_matches_label"])
        with self.assertRaisesRegex(ValueError, "Invalid class probability"):
            decision_from_probabilities(np.ones(8), LABELS[0])

        samples = []
        for label, result in [(LABELS[0], weak), (LABELS[0], strong),
                              ("unknown", decision_from_probabilities(other, "unknown"))]:
            item = dict(result)
            item["expected"] = label
            item.update({"rms": 0.01, "energy_trimmed_duration_s": 0.7,
                         "trimmed_fraction": 0.3})
            samples.append(item)
        overview = summarize(samples, "fake_validation")
        self.assertEqual(overview["raw_top_positive_accuracy"], 1.0)
        self.assertEqual(overview["fixed_gate_positive_recall"], 0.5)
        self.assertEqual(overview["unknown_false_positive_fraction"], 0)

    def test_saved_v3_diagnostic_preserves_audio_and_checks_split_fingerprint(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest = make_group_corpus(root)
            rows = load_group_manifest(root, manifest)
            train, validation, _ = split_grouped(rows, group_by="speaker", seed=42)
            engine = get_feature_engine(root)
            tx, y, vx, vy, _ = assemble_train_validation(
                root, train, validation, engine, variants=0, seed=42
            )
            weights, _ = train_v3(tx, y, vx, vy, seed=42, epochs=3, patience=2)
            metadata = {
                "version": MODEL_VERSION,
                "labels": LABELS,
                "seed": 42,
                "group_by": "speaker",
            }
            candidate = root / "artifacts" / "noise_augmented_shadow_v3.npz"
            save_v3(candidate, weights, metadata)
            report = {
                "model_metadata": metadata,
                "dataset": {
                    "train_original_files": len(train),
                    "validation_file_manifest_sha256": hashlib.sha256(
                        "\n".join(sorted(r["relative_path"] for r in validation))
                        .encode("utf-8")
                    ).hexdigest(),
                },
            }
            candidate.with_suffix(".report.json").write_text(
                json.dumps(report), encoding="utf-8"
            )
            before = hashlib.sha256(candidate.read_bytes()).hexdigest()
            result = diagnose(root, manifest, candidate)
            self.assertEqual(result["summary"]["validation"]["source_wavs"], 8)
            self.assertEqual(result["summary"]["training"]["source_wavs"], 8)
            self.assertEqual(len(result["fire_validation"]), 1)
            self.assertEqual(before, hashlib.sha256(candidate.read_bytes()).hexdigest())
            self.assertFalse((root / "artifacts" / "noise_augmented_shadow.npz").exists())
            with self.assertRaisesRegex(ValueError, "different split seed"):
                diagnose(root, manifest, candidate, seed=15)
            report["dataset"]["validation_file_manifest_sha256"] = "bad-hash"
            candidate.with_suffix(".report.json").write_text(
                json.dumps(report), encoding="utf-8"
            )
            with self.assertRaisesRegex(ValueError, "membership changed"):
                diagnose(root, manifest, candidate)

    def test_hard_negative_capture_is_training_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.assertEqual(destination(root, "hard_negative", "train"),
                             root / "train" / "hard_negative")
            wav(root / "train" / "hard_negative" / "similar-word.wav")
            self.assertEqual(
                list((root / "train" / "hard_negative").glob("*.wav"))[0].name,
                "similar-word.wav"
            )


if __name__ == "__main__":
    unittest.main()
