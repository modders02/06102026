"""V3 research-only noise KWS: group-disjoint validation and early stopping.

Does not load, write or overwrite active DTW templates, V1/V2 NPZ models,
pretrained Zipformer, Event History, or emergency alert decisions.
Uses ONLY local train/*.wav + noise/*.wav for training and validation.
The old heldout set is never used for hyperparameter selection; an explicitly
opted-in legacy benchmark is labeled exploratory.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys

import numpy as np

from msds.kws_engine import CustomKeywordEngine
from prepare_neural_kws import ROOT
from train_noise_augmented_kws import (
    ACCEPT_MARGIN, ACCEPT_THRESHOLD, DIM, LABELS, SAMPLE_RATE,
    audit_dataset, augment_audio, evaluate_holdout, feature_vector,
    noise_window, read_audio, wavs,
)
from noise_kws_v3_groups import (
    load_group_manifest, refresh_group_manifest, split_grouped,
)

MODEL_VERSION = "msds-noise-mlp-v3-validation"
HIDDEN_V3 = 32
DEFAULT_DATA = ROOT / "neural-kws-data"


def get_feature_engine(root: Path) -> CustomKeywordEngine:
    # An isolated feature-only location; active enrollment never accessed.
    return CustomKeywordEngine(data_dir=str(root / "_feature-only-no-enrollments"))


def assemble_train_validation(root: Path, train_rows: list[dict],
                              validation_rows: list[dict],
                              extractor: CustomKeywordEngine,
                              variants: int, seed: int):
    """Augment training groups ONLY; validation contains untouched source WAVs."""
    if variants < 0 or variants > 30:
        raise ValueError("variants must be 0-30")
    noise_sources = wavs(root / "noise")
    if len(noise_sources) < 3:
        raise ValueError("At least three real background-noise WAVs are required")
    noise_pool = [read_audio(p, extractor, background=True) for p in noise_sources]
    rng = np.random.default_rng(seed)
    tx, ty, vx, vy = [], [], [], []
    train_manifest = []
    validation_manifest = []
    for rows, xs, ys, names, augment in (
        (train_rows, tx, ty, train_manifest, True),
        (validation_rows, vx, vy, validation_manifest, False),
    ):
        for item in rows:
            path = root / item["relative_path"]
            try:
                clean = read_audio(path, extractor)
                vector = feature_vector(clean, extractor)
            except (OSError, ValueError, RuntimeError) as exc:
                raise ValueError(f"{item['relative_path']}: {exc}") from exc
            label_idx = LABELS.index(item["label"])
            xs.append(vector)
            ys.append(label_idx)
            names.append(item["relative_path"])
            if augment:
                for index in range(variants):
                    # Make the train data more diverse without creating
                    # fictitious independent validation speakers.
                    for trial in range(12):
                        try:
                            mixed = augment_audio(clean, noise_pool, rng)
                            feat = feature_vector(mixed, extractor)
                            break
                        except ValueError as exc:
                            if "No valid speech features detected" not in str(exc):
                                raise ValueError(
                                    f"{item['relative_path']} aug #{index}: {exc}"
                                ) from exc
                    else:
                        raise ValueError(
                            f"{item['relative_path']}: 12 augmentation attempts "
                            "could not produce valid acoustic features"
                        )
                    xs.append(feat)
                    ys.append(label_idx)
    # Negative-only synthetic background belongs to TRAIN; no augmented
    # derivatives from these sources are ever included in validation.
    for source in noise_pool:
        for _ in range(3):
            for trial in range(12):
                try:
                    feat = feature_vector(noise_window(source, SAMPLE_RATE, rng), extractor)
                    break
                except ValueError as exc:
                    if "No valid speech features detected" not in str(exc):
                        raise
            else:
                raise ValueError("Background-only noise has no usable negative features")
            tx.append(feat)
            ty.append(LABELS.index("unknown"))
    return (
        np.stack(tx).astype(np.float32), np.asarray(ty, dtype=np.int64),
        np.stack(vx).astype(np.float32), np.asarray(vy, dtype=np.int64),
        {
            "train_original_files": len(train_rows),
            "validation_original_files": len(validation_rows),
            "train_vectors": len(tx),
            "validation_vectors": len(vx),
            "synthetic_noise_negatives": len(noise_pool) * 3,
            "augmentation_variants_per_train_source": variants,
            "source_train_labels": dict(Counter(x["label"] for x in train_rows)),
            "source_validation_labels": dict(Counter(x["label"] for x in validation_rows)),
            "validation_augmentations": 0,
            "validation_file_manifest_sha256": hashlib.sha256(
                "\n".join(sorted(validation_manifest)).encode("utf-8")
            ).hexdigest(),
        },
    )


def balanced_ids(y: np.ndarray, rng: np.random.Generator,
                 per_class: int = 6) -> np.ndarray:
    """Each minibatch represents all eight classes regardless of source counts."""
    if per_class < 1:
        raise ValueError("per_class must be positive")
    ids = []
    for label in range(len(LABELS)):
        choices = np.flatnonzero(y == label)
        if not len(choices):
            raise ValueError(f"No TRAIN data for {LABELS[label]}")
        ids.extend(rng.choice(choices, size=per_class, replace=True).tolist())
    ids = np.asarray(ids, np.int64)
    rng.shuffle(ids)
    return ids


def validation_loss(x: np.ndarray, y: np.ndarray, weights: dict) -> float:
    from train_noise_augmented_kws import infer_probs

    probabilities = infer_probs(x, weights)
    ce = -np.log(np.maximum(probabilities[np.arange(len(y)), y], 1e-9))
    # Every class receives equal emphasis, including UNKNOWN.
    return float(np.mean([float(np.mean(ce[y == idx])) for idx in range(len(LABELS))]))


def train_v3(x: np.ndarray, y: np.ndarray, valid_x: np.ndarray, valid_y: np.ndarray,
             *, seed: int = 42, epochs: int = 90, patience: int = 12,
             dropout: float = 0.25, l2: float = 0.003,
             learning_rate: float = 0.001) -> tuple[dict, dict]:
    """Train small regularized MLP; choose checkpoint on TRAIN-ONLY group validation.

    No tuning by the old holdout set, no live-traffic influence, no model
    selection on augmented samples related to validation originals.
    """
    if not (1 <= epochs <= 500 and 2 <= patience <= 100):
        raise ValueError("epochs must be 1-500, patience 2-100")
    if not (0 <= dropout < 0.7 and 0 <= l2 <= 0.1):
        raise ValueError("dropout and L2 outside research-safe ranges")
    if x.ndim != 2 or valid_x.ndim != 2 or x.shape[1] != DIM or valid_x.shape[1] != DIM:
        raise ValueError("Invalid feature matrix")
    if len(x) != len(y) or len(valid_x) != len(valid_y):
        raise ValueError("X/y size mismatch")
    if any(not np.any(y == i) or not np.any(valid_y == i) for i in range(len(LABELS))):
        raise ValueError("Each of eight classes must occur in both train and validation")
    from train_noise_augmented_kws import infer_probs

    rng = np.random.default_rng(seed)
    mean = x.mean(axis=0).astype(np.float32)
    scale = np.maximum(x.std(axis=0), 0.08).astype(np.float32)
    z = ((x - mean) / scale).astype(np.float32)
    init = {
        "mean": mean, "scale": scale,
        "w1": (rng.normal(size=(DIM, HIDDEN_V3)) * np.sqrt(2 / DIM)).astype(np.float32),
        "b1": np.zeros(HIDDEN_V3, np.float32),
        "w2": (rng.normal(size=(HIDDEN_V3, len(LABELS)))
               * np.sqrt(2 / HIDDEN_V3)).astype(np.float32),
        "b2": np.zeros(len(LABELS), np.float32),
    }
    weights = init
    params = ("w1", "b1", "w2", "b2")
    mom = {p: np.zeros_like(weights[p]) for p in params}
    sq = {p: np.zeros_like(weights[p]) for p in params}
    step = 0
    lowest = float("inf")
    best = None
    best_epoch = 0
    wait = 0
    trace = []
    for epoch in range(1, epochs + 1):
        steps = max(8, int(np.ceil(len(y) / (len(LABELS) * 6))))
        for _ in range(steps):
            ids = balanced_ids(y, rng)
            batch = z[ids]
            targets = y[ids]
            h_pre = batch @ weights["w1"] + weights["b1"]
            hidden = np.maximum(h_pre, 0)
            if dropout:
                mask = (rng.random(hidden.shape) >= dropout).astype(np.float32)
                mask /= (1.0 - dropout)
                dropped = hidden * mask
            else:
                mask = np.ones_like(hidden)
                dropped = hidden
            scores = dropped @ weights["w2"] + weights["b2"]
            scores -= scores.max(axis=1, keepdims=True)
            numer = np.exp(scores)
            probabilities = numer / np.maximum(numer.sum(axis=1, keepdims=True), 1e-9)
            grad = probabilities.copy()
            grad[np.arange(len(ids)), targets] -= 1.0
            grad /= len(ids)
            derivative = {
                "w2": dropped.T @ grad + l2 * weights["w2"],
                "b2": grad.sum(axis=0),
            }
            dh = (grad @ weights["w2"].T) * mask * (h_pre > 0)
            derivative["w1"] = batch.T @ dh + l2 * weights["w1"]
            derivative["b1"] = dh.sum(axis=0)
            step += 1
            for p in params:
                mom[p] = 0.9 * mom[p] + 0.1 * derivative[p]
                sq[p] = 0.999 * sq[p] + 0.001 * derivative[p] ** 2
                mh = mom[p] / (1.0 - 0.9 ** step)
                vh = sq[p] / (1.0 - 0.999 ** step)
                weights[p] -= learning_rate * mh / (np.sqrt(vh) + 1e-8)
        loss = validation_loss(valid_x, valid_y, weights)
        train_prob = infer_probs(x, weights)
        train_loss = float(-np.log(np.maximum(train_prob[np.arange(len(y)), y], 1e-9)).mean())
        if not np.isfinite(loss):
            raise ValueError("Nonfinite validation loss")
        trace.append({
            "epoch": epoch, "train_loss": round(train_loss, 5),
            "validation_macro_loss": round(loss, 5),
        })
        if loss < lowest - 0.001:
            lowest = loss
            best = {name: values.copy() for name, values in weights.items()}
            best_epoch = epoch
            wait = 0
        else:
            wait += 1
        if epoch == 1 or epoch % 10 == 0 or wait >= patience:
            print(
                f"[Noise V3] epoch={epoch}/{epochs} "
                f"train_loss={train_loss:.4f} "
                f"val_macro_loss={loss:.4f} "
                f"best_epoch={best_epoch} patience={wait}/{patience}",
                flush=True,
            )
        if wait >= patience:
            break
    if best is None:
        raise ValueError("No valid checkpoint")
    return best, {
        "epochs_ran": epoch,
        "best_epoch": best_epoch,
        "best_validation_macro_loss": round(lowest, 5),
        "early_stopped": epoch < epochs,
        "dropout": dropout,
        "l2": l2,
        "balanced_minibatch": True,
        "history": trace,
    }


def save_v3(path: Path, weights: dict, metadata: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.stem + ".part.npz")
    try:
        np.savez_compressed(temp, **weights, metadata=json.dumps(metadata))
        temp.replace(path)
    finally:
        temp.unlink(missing_ok=True)


def load_v3(path: Path) -> tuple[dict, dict]:
    with np.load(path, allow_pickle=False) as model:
        weights = {p: np.asarray(model[p], dtype=np.float32) for p in
                   ("mean", "scale", "w1", "b1", "w2", "b2")}
        metadata = json.loads(str(model["metadata"]))
    if (metadata.get("version") != MODEL_VERSION or
            tuple(metadata.get("labels", ())) != LABELS):
        raise ValueError("Wrong V3 candidate version or label order")
    if (weights["mean"].shape != (DIM,) or weights["scale"].shape != (DIM,)
            or weights["w1"].shape != (DIM, HIDDEN_V3)
            or weights["b1"].shape != (HIDDEN_V3,)
            or weights["w2"].shape != (HIDDEN_V3, len(LABELS))
            or weights["b2"].shape != (len(LABELS),)):
        raise ValueError("Invalid V3 model shapes")
    if not all(np.isfinite(value).all() for value in weights.values()):
        raise ValueError("Nonfinite V3 candidate")
    return weights, metadata


def exploratory_legacy_holdout(root: Path, extractor: CustomKeywordEngine,
                                weights: dict) -> dict:
    x, y = [], []
    for idx, label in enumerate(LABELS):
        for file in wavs(root / "holdout" / label):
            x.append(feature_vector(read_audio(file, extractor), extractor))
            y.append(idx)
    if not x or any(int(np.sum(np.asarray(y) == i)) == 0 for i in range(len(LABELS))):
        raise ValueError("Legacy holdout requires all eight classes")
    return evaluate_holdout(np.stack(x), np.asarray(y), weights)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="V3 experimental KWS model with grouped train-only validation."
    )
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA)
    parser.add_argument("--manifest", type=Path, default=None)
    parser.add_argument("--init-groups", action="store_true",
                        help="Create/refresh private CSV, never infer real speakers")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--group-by", choices=("speaker", "session"), default="speaker")
    parser.add_argument("--epochs", type=int, default=90)
    parser.add_argument("--patience", type=int, default=12)
    parser.add_argument("--variants", type=int, default=4)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--exploratory-legacy-holdout", action="store_true",
                        help="Opt-in only: do NOT use this result for checkpoint selection")
    args = parser.parse_args()
    root = args.data.resolve()
    manifest_path = (args.manifest or (root / "group_manifest_v3.csv")).resolve()
    if args.init_groups:
        try:
            status = refresh_group_manifest(root, manifest_path)
            print(json.dumps(status, indent=2))
            print(
                "[Noise V3] Edit private CSV: assign speaker_id and session_id "
                "to each training WAV (same voice -> same speaker_id). "
                "Do not upload any voice recordings or personal names."
            )
            return 0
        except (OSError, ValueError) as exc:
            print(f"[Noise V3] Cannot update manifest: {exc}", file=sys.stderr)
            return 2
    extractor = get_feature_engine(root)
    audit = audit_dataset(root, extractor)
    if not audit["passed"]:
        print(json.dumps(audit, indent=2))
        print("[Noise V3] Original WAV quality check failed", file=sys.stderr)
        return 2
    try:
        rows = load_group_manifest(root, manifest_path)
        # Hard negatives are explicitly recorded in train/hard_negative; inspect
        # acoustic quality, but never infer that speech content is actually negative.
        for item in rows:
            if item["relative_path"].startswith("train/hard_negative/"):
                raw = read_audio(root / item["relative_path"], extractor)
                feature_vector(raw, extractor)
        training, validation, split_report = split_grouped(
            rows, group_by=args.group_by, seed=args.seed,
        )
    except (OSError, ValueError, RuntimeError) as exc:
        print(f"[Noise V3] Group validation unavailable: {exc}", file=sys.stderr)
        return 2
    print(json.dumps({
        "status": "group_validated",
        "validation": split_report,
        "audio_audit": audit,
        "legacy_holdout_used_for_selection": False,
    }, indent=2))
    if args.check:
        return 0
    try:
        x, y, vx, vy, data_summary = assemble_train_validation(
            root, training, validation, extractor, args.variants, args.seed,
        )
        print(
            f"[Noise V3] train={len(x)} vectors, validation={len(vx)} "
            f"original WAVs; external holdout not used",
            flush=True,
        )
        weights, fit = train_v3(
            x, y, vx, vy, seed=args.seed, epochs=args.epochs,
            patience=args.patience,
        )
        val_metrics = evaluate_holdout(vx, vy, weights)
        legacy = (
            exploratory_legacy_holdout(root, extractor, weights)
            if args.exploratory_legacy_holdout else None
        )
    except (OSError, ValueError, RuntimeError) as exc:
        print(f"[Noise V3] Training rejected: {exc}", file=sys.stderr)
        return 3
    target = root / "artifacts" / "noise_augmented_shadow_v3.npz"
    metadata = {
        "version": MODEL_VERSION, "labels": LABELS,
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "model_kind": "standalone regularized 32-hidden-unit NumPy MLP",
        "seed": args.seed, "group_by": args.group_by,
        "accept_threshold": ACCEPT_THRESHOLD, "accept_margin": ACCEPT_MARGIN,
        "validation_selected_checkpoint": True,
        "shadow_only": True, "live_alerts_authorized": False,
    }
    save_v3(target, weights, metadata)
    report = {
        "candidate": str(target),
        "model_metadata": metadata,
        "group_split": split_report, "dataset": data_summary,
        "fit": fit, "training_only_validation": val_metrics,
        "legacy_holdout_exploratory_only": legacy,
        "old_model_files_overwritten": False,
        "active_dtw_templates_modified": False,
        "warning": (
            "V3 is an isolated research candidate. Split-group validation is "
            "NOT an independent final test. Prior holdout has already "
            "influenced experiments. Collect new disjoint final test WAVs."
        ),
    }
    report_path = target.with_suffix(".report.json")
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({
        "saved_candidate": str(target),
        "saved_report": str(report_path),
        "best_epoch": fit["best_epoch"],
        "early_stopped": fit["early_stopped"],
        "validation": val_metrics,
        "legacy_holdout_exploratory_only": legacy,
        "operational_detection_unchanged": True,
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
