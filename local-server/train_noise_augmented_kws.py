"""Train an OFFLINE noise-augmented English KWS classifier for shadow tests.

This trains a new small NumPy MLP, NOT the pretrained sherpa-onnx Zipformer.
It NEVER loads or overwrites active KWS enrollment files, sends alerts, or
uses held-out speech to choose training parameters or a detection threshold.

Data layout (all files local, ignored by Git):
  local-server/neural-kws-data/train/help/*.wav  (all seven keywords)
  local-server/neural-kws-data/train/unknown/*.wav
  local-server/neural-kws-data/holdout/help/*.wav ... /unknown/*.wav
  local-server/neural-kws-data/noise/*.wav       (fan/TV/etc without trigger words)

WAVs can use mono/stereo 8/16-bit PCM; canonical input is 16 kHz.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import sys
from datetime import datetime, timezone

import numpy as np

HERE = Path(__file__).resolve().parent
from msds.kws_engine import CustomKeywordEngine, SAMPLE_RATE, N_MELS
from prepare_neural_kws import KEYWORDS

LABELS = (*KEYWORDS, "unknown")
MIN_TRAIN = 5
MIN_TRAIN_UNKNOWN = 10
MIN_HOLDOUT = 3
MIN_HOLDOUT_UNKNOWN = 10
MIN_NOISE = 3
MAX_WAV_MB = 6
MIN_DURATION = 0.30
MAX_DURATION = 2.50
STEPS = 16
DIM = STEPS * N_MELS
HIDDEN = 64
ACCEPT_THRESHOLD = 0.80
ACCEPT_MARGIN = 0.15
MODEL_VERSION = "msds-noise-mlp-v1"


def wavs(folder: Path) -> list[Path]:
    if not folder.is_dir():
        return []
    # No symlink traversal or outside-file import into local training data.
    return [p for p in sorted(folder.iterdir())
            if p.suffix.lower() == ".wav" and p.is_file() and not p.is_symlink()]


def read_audio(path: Path, feature_engine: CustomKeywordEngine, *, background=False) -> np.ndarray:
    if not path.is_file() or path.is_symlink() or path.stat().st_size > MAX_WAV_MB * 1024 * 1024:
        raise ValueError(f"Missing/unsafe/oversized WAV: {path}")
    pcm = feature_engine._read_wav_as_pcm16k_mono(path)
    samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
    duration = len(samples) / SAMPLE_RATE
    if background:
        if not 0.5 <= duration <= 30:
            raise ValueError(f"Background noise must be 0.5-30 seconds: {path.name}")
    elif not MIN_DURATION <= duration <= MAX_DURATION:
        raise ValueError(f"Utterance must be {MIN_DURATION}-{MAX_DURATION}s: {path.name}")
    if not np.isfinite(samples).all() or float(np.max(np.abs(samples), initial=0)) < 0.001:
        raise ValueError(f"Silent or invalid recording: {path.name}")
    return samples


def inventory(root: Path) -> dict:
    train = {label: wavs(root / "train" / label) for label in LABELS}
    holdout = {label: wavs(root / "holdout" / label) for label in LABELS}
    noise = wavs(root / "noise")
    coverage = {
        label: {
            "train": len(train[label]), "required_train":
                MIN_TRAIN_UNKNOWN if label == "unknown" else MIN_TRAIN,
            "holdout": len(holdout[label]), "required_holdout":
                MIN_HOLDOUT_UNKNOWN if label == "unknown" else MIN_HOLDOUT,
        }
        for label in LABELS
    }
    ready = (len(noise) >= MIN_NOISE and
             all(counts["train"] >= counts["required_train"] and
                 counts["holdout"] >= counts["required_holdout"]
                 for counts in coverage.values()))
    return {"ready": ready, "coverage": coverage, "noise": len(noise),
            "required_noise": MIN_NOISE, "root": str(root)}


def check_disjoint(train: dict, holdout: dict, noise: list[Path]) -> None:
    """No identical files across train/holdout; no shared actual WAV content.

    Augmented derivatives never appear in holdout because they are created
    in memory after this check, exclusively from train WAVs.
    """
    seen: dict[str, str] = {}
    groups = [
        *[(f"train/{label}", paths) for label, paths in train.items()],
        *[(f"holdout/{label}", paths) for label, paths in holdout.items()],
        ("noise", noise),
    ]
    for group, paths in groups:
        for path in paths:
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            if digest in seen:
                raise ValueError(f"Duplicate WAV content in {seen[digest]} and {group}: {path.name}")
            seen[digest] = group


def noise_window(samples: np.ndarray, size: int, rng: np.random.Generator) -> np.ndarray:
    if len(samples) >= size:
        offset = int(rng.integers(0, len(samples) - size + 1))
        return samples[offset:offset + size].copy()
    repeats = math.ceil(size / len(samples))
    return np.tile(samples, repeats)[:size].astype(np.float32)


def augment_audio(clean: np.ndarray, noise_pool: list[np.ndarray],
                  rng: np.random.Generator, snr_db: float | None = None,
                  force_noise: bool = False) -> np.ndarray:
    """Causal echo, level variation and additive environmental noise at target SNR.

    Preserves the original label. NO augmentation is applied to heldout WAVs.
    """
    sound = np.asarray(clean, dtype=np.float32).copy()
    if not len(sound) or not np.isfinite(sound).all():
        raise ValueError("Invalid augmentation source")
    sound *= float(rng.uniform(0.65, 1.25))
    if rng.random() < 0.6:
        delay = int(rng.uniform(0.025, 0.095) * SAMPLE_RATE)
        decay = float(rng.uniform(0.12, 0.38))
        if delay < len(sound):
            original = sound.copy()
            sound[delay:] += original[:-delay] * decay
        # Simple echo is a simulation, not a measured room impulse response.
    if snr_db is None:
        snr_db = float(rng.uniform(0, 22))
    if force_noise or rng.random() < 0.85:
        if not noise_pool:
            raise ValueError("Real background-noise recordings are required")
        background = noise_window(noise_pool[int(rng.integers(len(noise_pool)))],
                                  len(sound), rng)
        background -= background.mean()
        clean_rms = float(np.sqrt(np.mean(sound * sound) + 1e-12))
        noise_rms = float(np.sqrt(np.mean(background * background) + 1e-12))
        if noise_rms < 1e-5:
            raise ValueError("Background WAV is essentially silent")
        background *= (clean_rms / noise_rms) * 10 ** (-snr_db / 20)
        sound += background
    peak = float(np.max(np.abs(sound)))
    if peak > 0.98:
        sound *= 0.98 / peak
    return np.clip(sound, -1.0, 1.0).astype(np.float32)


def feature_vector(samples: np.ndarray, extractor: CustomKeywordEngine) -> np.ndarray:
    # Reuse the tested Log-Mel feature extractor but not its enrollment store.
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2").tobytes()
    mel = extractor.extract_features(pcm)
    if mel.ndim != 2 or mel.shape[1] != N_MELS or len(mel) < 12:
        raise ValueError(
            "No valid speech features detected "
            f"(log-Mel frames={len(mel) if mel.ndim == 2 else 'invalid'}, "
            f"input_duration={len(samples) / SAMPLE_RATE:.2f}s; "
            "may be truncated speech, a short impact or sparse background)"
        )
    # Linear time resampling to fixed 16 x 32; retain phoneme transitions.
    pos = np.linspace(0, len(mel) - 1, STEPS, dtype=np.float32)
    low = np.floor(pos).astype(np.int32)
    high = np.minimum(low + 1, len(mel) - 1)
    alpha = (pos - low)[:, None]
    sampled = mel[low] * (1 - alpha) + mel[high] * alpha
    vector = sampled.reshape(DIM).astype(np.float32)
    if not np.isfinite(vector).all():
        raise ValueError("Nonfinite log-Mel features")
    return vector


def encode_dataset(root: Path, extractor: CustomKeywordEngine,
                   rng: np.random.Generator, variants: int) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, dict]:
    train_paths = {label: wavs(root / "train" / label) for label in LABELS}
    holdout_paths = {label: wavs(root / "holdout" / label) for label in LABELS}
    noise_paths = wavs(root / "noise")
    check_disjoint(train_paths, holdout_paths, noise_paths)

    noise_pool = [read_audio(p, extractor, background=True) for p in noise_paths]
    x_train, y_train, x_test, y_test = [], [], [], []
    # For reproducibility, every augmented variant is derived from a TRAIN source only.
    for label_idx, label in enumerate(LABELS):
        for path in train_paths[label]:
            clean = read_audio(path, extractor)
            x_train.append(feature_vector(clean, extractor))
            y_train.append(label_idx)
            for _ in range(variants):
                mixed = augment_audio(clean, noise_pool, rng)
                x_train.append(feature_vector(mixed, extractor))
                y_train.append(label_idx)
        # Actual holdout files are evaluated exactly as provided.
        for path in holdout_paths[label]:
            clean = read_audio(path, extractor)
            x_test.append(feature_vector(clean, extractor))
            y_test.append(label_idx)

    # Noise without any keyword is additionally taught as a negative class.
    for noise in noise_pool:
        for _ in range(3):
            background = noise_window(noise, SAMPLE_RATE, rng)
            x_train.append(feature_vector(background, extractor))
            y_train.append(len(LABELS) - 1)

    manifest = {
        "train_source_files": {label: len(files) for label, files in train_paths.items()},
        "heldout_source_files": {label: len(files) for label, files in holdout_paths.items()},
        "noise_sources": len(noise_pool),
        "variants_per_train_source": variants,
        "evaluation_augmentations": 0,
    }
    return (np.stack(x_train), np.asarray(y_train, dtype=np.int64),
            np.stack(x_test), np.asarray(y_test, dtype=np.int64), manifest)


def audit_dataset(root: Path, extractor: CustomKeywordEngine) -> dict:
    """Inspect real audio (not just counts) without verifying spoken words."""
    train = {label: wavs(root / "train" / label) for label in LABELS}
    holdout = {label: wavs(root / "holdout" / label) for label in LABELS}
    noise = wavs(root / "noise")
    issues = []
    inspected = 0
    try:
        check_disjoint(train, holdout, noise)
    except (OSError, ValueError) as exc:
        issues.append({"file": "(dataset)", "reason": str(exc)})
    for subset, sources in (("train", train), ("holdout", holdout)):
        for label, paths in sources.items():
            for path in paths:
                inspected += 1
                try:
                    raw = read_audio(path, extractor)
                    feature_vector(raw, extractor)
                except (OSError, ValueError, RuntimeError) as exc:
                    issues.append({
                        "file": f"{subset}/{label}/{path.name}",
                        "reason": str(exc),
                        "action": "Listen to WAV and re-record if silent, clipped or transient-only.",
                    })
    for path in noise:
        inspected += 1
        try:
            read_audio(path, extractor, background=True)
        except (OSError, ValueError, RuntimeError) as exc:
            issues.append({
                "file": f"noise/{path.name}", "reason": str(exc),
                "action": "Replace with continuous background-only noise.",
            })
    return {
        "passed": not issues,
        "recordings_scanned": inspected,
        "issues": issues,
        "speech_labels_not_verified": True,
    }


def build_variant(clean: np.ndarray, noise_pool: list[np.ndarray],
                  rng: np.random.Generator, extractor: CustomKeywordEngine,
                  description: str, *, background: bool = False,
                  max_attempts: int = 12) -> tuple[np.ndarray, int]:
    """Retry short transient-only synthetic windows, never bad real WAVs."""
    last_error = None
    for attempt in range(max_attempts):
        try:
            sound = (
                noise_window(clean, SAMPLE_RATE, rng)
                if background else augment_audio(clean, noise_pool, rng)
            )
            return feature_vector(sound, extractor), attempt
        except ValueError as exc:
            if "No valid speech features detected" not in str(exc):
                raise ValueError(f"{description}: {exc}") from exc
            last_error = exc
    raise ValueError(
        f"{description}: all {max_attempts} synthetic attempts had "
        f"unusable acoustic features ({last_error}); "
        "inspect the source WAV or record longer continuous noise."
    )


def softmax(logits: np.ndarray) -> np.ndarray:
    centered = logits - logits.max(axis=1, keepdims=True)
    exp = np.exp(centered)
    return exp / np.maximum(exp.sum(axis=1, keepdims=True), 1e-12)


def infer_probs(x: np.ndarray, weights: dict) -> np.ndarray:
    z = (x - weights["mean"]) / weights["scale"]
    hidden = np.maximum(0, z @ weights["w1"] + weights["b1"])
    return softmax(hidden @ weights["w2"] + weights["b2"])


def train_mlp(x: np.ndarray, y: np.ndarray, *, epochs: int,
              seed: int, learning_rate: float = 0.002) -> dict:
    """Two-layer supervised NumPy MLP; no external neural training stack."""
    rng = np.random.default_rng(seed)
    mean = x.mean(axis=0).astype(np.float32)
    scale = np.maximum(x.std(axis=0), 0.08).astype(np.float32)
    z = ((x - mean) / scale).astype(np.float32)
    classes = len(LABELS)
    weights = {
        "mean": mean, "scale": scale,
        "w1": (rng.normal(size=(z.shape[1], HIDDEN)) * np.sqrt(2 / z.shape[1])).astype(np.float32),
        "b1": np.zeros(HIDDEN, np.float32),
        "w2": (rng.normal(size=(HIDDEN, classes)) * np.sqrt(2 / HIDDEN)).astype(np.float32),
        "b2": np.zeros(classes, np.float32),
    }
    params = ("w1", "b1", "w2", "b2")
    mom = {p: np.zeros_like(weights[p]) for p in params}
    variance = {p: np.zeros_like(weights[p]) for p in params}
    step = 0
    last_loss = None
    for epoch in range(epochs):
        shuffled = rng.permutation(len(z))
        for start in range(0, len(shuffled), 48):
            ids = shuffled[start:start + 48]
            batch = z[ids]
            onehot = np.eye(classes, dtype=np.float32)[y[ids]]
            hpre = batch @ weights["w1"] + weights["b1"]
            h = np.maximum(hpre, 0)
            prob = softmax(h @ weights["w2"] + weights["b2"])
            grad = (prob - onehot) / len(ids)
            deriv = {
                "w2": h.T @ grad + 0.0002 * weights["w2"],
                "b2": grad.sum(axis=0),
            }
            dh = (grad @ weights["w2"].T) * (hpre > 0)
            deriv["w1"] = batch.T @ dh + 0.0002 * weights["w1"]
            deriv["b1"] = dh.sum(axis=0)
            step += 1
            for p in params:
                mom[p] = 0.9 * mom[p] + 0.1 * deriv[p]
                variance[p] = 0.999 * variance[p] + 0.001 * (deriv[p] ** 2)
                corrected_m = mom[p] / (1 - 0.9 ** step)
                corrected_v = variance[p] / (1 - 0.999 ** step)
                weights[p] -= learning_rate * corrected_m / (np.sqrt(corrected_v) + 1e-8)
        if epoch == epochs - 1 or epoch % 10 == 0:
            probs = infer_probs(x, weights)
            last_loss = float(-np.log(np.maximum(probs[np.arange(len(y)), y], 1e-8)).mean())
            print(f"[Noise train] epoch={epoch + 1}/{epochs} train_loss={last_loss:.4f}", flush=True)
    return weights


def predict_one(vector: np.ndarray, weights: dict) -> tuple[str, float, float]:
    probs = infer_probs(vector.reshape(1, DIM), weights)[0]
    index = int(np.argmax(probs))
    best = float(probs[index])
    runner = float(np.partition(probs, -2)[-2])
    if LABELS[index] == "unknown" or best < ACCEPT_THRESHOLD or best - runner < ACCEPT_MARGIN:
        return "unknown", best, best - runner
    return LABELS[index], best, best - runner


def evaluate_holdout(x: np.ndarray, y: np.ndarray, weights: dict) -> dict:
    confusion = {actual: {pred: 0 for pred in LABELS} for actual in LABELS}
    per_label = {}
    counts = np.zeros((len(LABELS), 2), dtype=np.int64)
    for vector, actual_idx in zip(x, y):
        predicted, _, _ = predict_one(vector, weights)
        actual = LABELS[int(actual_idx)]
        confusion[actual][predicted] += 1
        counts[actual_idx, 0] += 1
        if predicted == actual:
            counts[actual_idx, 1] += 1
    for idx, label in enumerate(LABELS):
        per_label[label] = {
            "count": int(counts[idx, 0]), "correct": int(counts[idx, 1]),
            "recall": round(float(counts[idx, 1]) / max(1, int(counts[idx, 0])), 4),
        }
    positives = counts[:-1]
    positives_correct = int(positives[:, 1].sum())
    positives_all = int(positives[:, 0].sum())
    negative_total = int(counts[-1, 0])
    negative_false = negative_total - int(counts[-1, 1])
    return {
        "positive_recall": round(positives_correct / max(1, positives_all), 4),
        "unknown_false_positive_rate": round(negative_false / max(1, negative_total), 4),
        "unknown_false_positive_count": negative_false,
        "confusion": confusion,
        "per_label": per_label,
        "eligible_for_further_research": bool(
            positives_all and negative_total and
            positives_correct / positives_all >= 0.90 and
            negative_false / negative_total <= 0.05
        ),
        "warning": "Clip-level offline results do NOT establish false alarms per hour or live performance.",
    }


def save_model(path: Path, weights: dict, metadata: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Only NumPy arrays, no pickled Python objects; not a deployment artifact.
    temp = path.with_name(path.stem + ".part.npz")
    try:
        np.savez_compressed(temp, **weights, metadata=json.dumps(metadata))
        temp.replace(path)
    finally:
        temp.unlink(missing_ok=True)


def load_model(path: Path) -> tuple[dict, dict]:
    with np.load(path, allow_pickle=False) as data:
        weights = {p: np.asarray(data[p], dtype=np.float32)
                   for p in ("mean", "scale", "w1", "b1", "w2", "b2")}
        metadata = json.loads(str(data["metadata"]))
    if metadata.get("version") != MODEL_VERSION or tuple(metadata.get("labels", [])) != LABELS:
        raise ValueError("Wrong candidate model format or label order")
    if (weights["mean"].shape != (DIM,) or weights["scale"].shape != (DIM,) or
            weights["w1"].shape != (DIM, HIDDEN) or weights["b1"].shape != (HIDDEN,) or
            weights["w2"].shape != (HIDDEN, len(LABELS)) or
            weights["b2"].shape != (len(LABELS),)):
        raise ValueError("Invalid model parameter shapes")
    if not all(np.isfinite(v).all() for v in weights.values()):
        raise ValueError("Nonfinite model weights")
    return weights, metadata


def main() -> int:
    parser = argparse.ArgumentParser(description="Train an isolated noise-augmented English KWS MLP.")
    parser.add_argument("--data", type=Path, default=HERE / "neural-kws-data")
    parser.add_argument("--check", action="store_true", help="Inspect dataset requirements without training")
    parser.add_argument("--epochs", type=int, default=60)
    parser.add_argument("--variants", type=int, default=6, help="Noise/room variants per training WAV")
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()
    if not (1 <= args.epochs <= 500 and 1 <= args.variants <= 30):
        parser.error("epochs must be 1-500; variants must be 1-30")
    root = args.data.resolve()
    report = inventory(root)
    print(json.dumps(report, indent=2))
    if args.check:
        return 0 if report["ready"] else 2
    if not report["ready"]:
        print("[Noise train] Missing real labeled source WAVs; no model trained.", file=sys.stderr)
        return 2
    # Empty directory redirects feature extractor away from active DTW storage.
    extractor = CustomKeywordEngine(data_dir=str(root / "_feature-only-no-enrollments"))
    rng = np.random.default_rng(args.seed)
    try:
        x, y, test_x, test_y, manifest = encode_dataset(root, extractor, rng, args.variants)
        print("[Noise train] Input vectors:", len(x), "| heldout:", len(test_x), flush=True)
        weights = train_mlp(x, y, epochs=args.epochs, seed=args.seed)
        heldout = evaluate_holdout(test_x, test_y, weights)
    except (OSError, ValueError, RuntimeError) as exc:
        print(f"[Noise train] Rejected dataset: {exc}", file=sys.stderr)
        return 3
    metadata = {
        "version": MODEL_VERSION, "labels": LABELS,
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "data_counts": manifest, "seed": args.seed, "epochs": args.epochs,
        "accept_threshold": ACCEPT_THRESHOLD, "accept_margin": ACCEPT_MARGIN,
        "model_kind": "standalone numpy 2-layer MLP with Log-Mel inputs",
        "shadow_only": True, "live_alerts_authorized": False,
    }
    target = root / "artifacts" / "noise_augmented_shadow.npz"
    save_model(target, weights, metadata)
    result = {"saved_candidate": str(target), "training": manifest, "holdout": heldout,
              "shadow_only": True, "active_dtw_templates_modified": False,
              "note": "Zipformer weights were NOT fine-tuned; this is a separate supervised classifier."}
    report_path = target.with_suffix(".report.json")
    report_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result, indent=2))
    print(f"[Noise train] Candidate only: {target} (NOT installed in MSDS)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
