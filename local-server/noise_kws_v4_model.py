"""Small NumPy temporal CNN for isolated offline V4 keyword experiments.

Architecture: 48x32 ordered Log-Mel -> learned 5-frame convolution
-> ReLU -> 1/2/4 temporal pyramid average pooling -> eight-class softmax.

NumPy-only, trained from scratch with class-balanced minibatches and Adam.
No Torch, cloud APIs, pretrained weights, active DTW data or live alerts.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

MODEL_VERSION = "msds-kws-v4-temporal-cnn-research"
STEPS = 48
MELS = 32
KERNEL = 5
CHANNELS = 24
CLASSES = 8
POOL_BINS = 7
EPS = 1e-8


def temporal_bins(n: int) -> tuple[tuple[int, int], ...]:
    if n < 8:
        raise ValueError("Not enough convolution frames")
    chunks = [(0, n)]
    for pieces in (2, 4):
        chunks += [(i * n // pieces, (i + 1) * n // pieces)
                   for i in range(pieces)]
    return tuple(chunks)


def _validate_features(x: np.ndarray) -> None:
    if x.ndim != 3 or x.shape[1:] != (STEPS, MELS):
        raise ValueError(f"Expected (N,{STEPS},{MELS}) sequence features")
    if len(x) == 0 or not np.isfinite(x).all():
        raise ValueError("Empty/nonfinite feature sequences")


def normalize(x: np.ndarray, w: dict) -> np.ndarray:
    _validate_features(x)
    return np.clip(
        (x - w["mean"][None, None, :]) /
        w["scale"][None, None, :], -6.0, 6.0
    ).astype(np.float32)


def initialize(x: np.ndarray, seed: int) -> dict:
    _validate_features(x)
    rng = np.random.default_rng(seed)
    mean = x.mean(axis=(0, 1)).astype(np.float32)
    scale = np.maximum(x.std(axis=(0, 1)), 0.05).astype(np.float32)
    return {
        "mean": mean,
        "scale": scale,
        "conv_w": (
            rng.normal(size=(KERNEL * MELS, CHANNELS))
            * np.sqrt(2.0 / (KERNEL * MELS))
        ).astype(np.float32),
        "conv_b": np.zeros(CHANNELS, np.float32),
        "out_w": (
            rng.normal(size=(POOL_BINS * CHANNELS, CLASSES))
            * np.sqrt(2.0 / (POOL_BINS * CHANNELS))
        ).astype(np.float32),
        "out_b": np.zeros(CLASSES, np.float32),
    }


def _forward(z: np.ndarray, w: dict):
    # [N,T,mel,5] -> [N,T,5,mel] -> [N,T,160].
    from numpy.lib.stride_tricks import sliding_window_view
    raw = sliding_window_view(z, KERNEL, axis=1)
    patches = np.ascontiguousarray(
        raw.transpose(0, 1, 3, 2).reshape(len(z), STEPS - KERNEL + 1, -1)
    )
    pre = patches @ w["conv_w"] + w["conv_b"]
    activated = np.maximum(pre, 0.0)
    bins = temporal_bins(activated.shape[1])
    pooled = np.concatenate(
        [activated[:, start:end].mean(axis=1) for start, end in bins],
        axis=1,
    )
    logits = pooled @ w["out_w"] + w["out_b"]
    logits = logits - logits.max(axis=1, keepdims=True)
    ex = np.exp(logits)
    probs = ex / np.maximum(ex.sum(axis=1, keepdims=True), EPS)
    return probs, patches, pre, pooled, bins


def predict_proba(x: np.ndarray, w: dict) -> np.ndarray:
    return _forward(normalize(x, w), w)[0]


def predict_fixed_gate(probabilities: np.ndarray, *, threshold: float = 0.80,
                       margin: float = 0.15) -> int:
    """Research-only benchmark gate, never connected to the MSDS alert path.

    Returns 7 (= UNKNOWN) if top class is unknown or confidence is weak.
    """
    a = np.asarray(probabilities)
    if a.shape != (CLASSES,) or not np.isfinite(a).all():
        raise ValueError("Invalid probability vector")
    order = np.argsort(-a, kind="stable")
    top, runner = int(order[0]), int(order[1])
    if top == CLASSES - 1 or a[top] < threshold or a[top] - a[runner] < margin:
        return CLASSES - 1
    return top


def _macro_loss(x: np.ndarray, y: np.ndarray, w: dict) -> float:
    p = predict_proba(x, w)
    ce = -np.log(np.maximum(p[np.arange(len(y)), y], 1e-9))
    return float(np.mean([ce[y == i].mean() for i in range(CLASSES)]))


def fit_temporal_cnn(
    train_x: np.ndarray, train_y: np.ndarray,
    validation_x: np.ndarray, validation_y: np.ndarray,
    *, epochs: int = 65, patience: int = 10, seed: int = 42,
    dropout: float = 0.15, l2: float = 0.002,
    learning_rate: float = 0.0015,
) -> tuple[dict, dict]:
    """Train only on train groups; select checkpoint on held-out *sessions*.

    Validation labels affect early stopping only, never preprocessing,
    normalization statistics, sampling, weights, or threshold calibration.
    """
    tx = np.asarray(train_x, np.float32)
    vx = np.asarray(validation_x, np.float32)
    ty = np.asarray(train_y, np.int64)
    vy = np.asarray(validation_y, np.int64)
    _validate_features(tx)
    _validate_features(vx)
    if len(tx) != len(ty) or len(vx) != len(vy):
        raise ValueError("Features and labels do not match")
    if not (2 <= patience <= 100 and 1 <= epochs <= 250):
        raise ValueError("Invalid epochs/patience")
    if not 0 <= dropout < 0.6 or not 0 <= l2 <= 0.05:
        raise ValueError("Invalid regularization")
    if any(not np.any(ty == i) or not np.any(vy == i) for i in range(CLASSES)):
        raise ValueError("All eight classes required in train AND validation")
    rng = np.random.default_rng(seed)
    w = initialize(tx, seed)
    z = normalize(tx, w)
    indices = [np.flatnonzero(ty == cls) for cls in range(CLASSES)]
    params = ("conv_w", "conv_b", "out_w", "out_b")
    first = {p: np.zeros_like(w[p]) for p in params}
    second = {p: np.zeros_like(w[p]) for p in params}
    step = 0
    best, best_loss, best_epoch, wait = None, float("inf"), 0, 0
    history = []
    per_class = 3
    steps_per_epoch = max(5, int(np.ceil(len(tx) / (CLASSES * per_class))))
    for epoch in range(1, epochs + 1):
        for _ in range(steps_per_epoch):
            ids = np.concatenate([
                rng.choice(idx, size=per_class, replace=True)
                for idx in indices
            ])
            rng.shuffle(ids)
            samples = z[ids]
            probs, patches, pre, pooled, bins = _forward(samples, w)
            n = len(ids)
            mask = (
                (rng.random(pooled.shape) >= dropout).astype(np.float32)
                / (1.0 - dropout)
                if dropout else np.ones_like(pooled)
            )
            if dropout:
                logits = (pooled * mask) @ w["out_w"] + w["out_b"]
                logits -= logits.max(axis=1, keepdims=True)
                e = np.exp(logits)
                probs = e / np.maximum(e.sum(axis=1, keepdims=True), EPS)
            grad_logits = probs.copy()
            grad_logits[np.arange(n), ty[ids]] -= 1.0
            grad_logits /= n
            grad_out_w = (pooled * mask).T @ grad_logits + l2 * w["out_w"]
            grad_out_b = grad_logits.sum(axis=0)
            grad_pooled = (
                grad_logits @ w["out_w"].T * mask
            ).reshape(n, POOL_BINS, CHANNELS)
            grad_activation = np.zeros_like(pre)
            for k, (start, end) in enumerate(bins):
                grad_activation[:, start:end] += (
                    grad_pooled[:, k, None, :] / (end - start)
                )
            grad_pre = grad_activation * (pre > 0.0)
            grad_conv_w = (
                patches.reshape(-1, KERNEL * MELS).T
                @ grad_pre.reshape(-1, CHANNELS)
                + l2 * w["conv_w"]
            )
            grad_conv_b = grad_pre.sum(axis=(0, 1))
            grads = {
                "conv_w": grad_conv_w, "conv_b": grad_conv_b,
                "out_w": grad_out_w, "out_b": grad_out_b,
            }
            # Per-batch global norm clipping avoids exploding updates from
            # rare, extremely noisy CCTV training clips.
            norm = np.sqrt(sum(float(np.sum(g * g)) for g in grads.values()))
            if not np.isfinite(norm):
                raise ValueError("Nonfinite training gradient")
            if norm > 5.0:
                grads = {name: g * (5.0 / norm) for name, g in grads.items()}
            step += 1
            for p in params:
                first[p] = 0.9 * first[p] + 0.1 * grads[p]
                second[p] = 0.999 * second[p] + 0.001 * grads[p] ** 2
                a = first[p] / (1.0 - 0.9 ** step)
                b = second[p] / (1.0 - 0.999 ** step)
                w[p] -= learning_rate * a / (np.sqrt(b) + 1e-8)
        val_loss = _macro_loss(vx, vy, w)
        training_probs = predict_proba(tx, w)
        train_loss = float(-np.log(
            np.maximum(training_probs[np.arange(len(ty)), ty], 1e-9)
        ).mean())
        if not np.isfinite(val_loss):
            raise ValueError("Nonfinite validation loss")
        history.append({
            "epoch": epoch,
            "training_cross_entropy": round(train_loss, 5),
            "validation_macro_cross_entropy": round(val_loss, 5),
        })
        if val_loss < best_loss - 0.001:
            best_loss = val_loss
            best = {p: arr.copy() for p, arr in w.items()}
            best_epoch, wait = epoch, 0
        else:
            wait += 1
        if epoch == 1 or epoch % 10 == 0 or wait >= patience:
            print(
                f"[Noise V4] epoch={epoch}/{epochs} "
                f"train_loss={train_loss:.4f} val_macro_loss={val_loss:.4f} "
                f"best_epoch={best_epoch} patience={wait}/{patience}",
                flush=True,
            )
        if wait >= patience:
            break
    assert best is not None
    return best, {
        "best_epoch": best_epoch,
        "epochs_ran": epoch,
        "best_validation_macro_loss": round(best_loss, 5),
        "early_stopped": epoch < epochs,
        "validation_used_for_early_stopping": True,
        "patience": patience,
        "dropout": dropout,
        "l2": l2,
        "learning_rate": learning_rate,
        "class_balanced_minibatches": True,
        "history": history,
    }


def save_model(path: Path, w: dict, metadata: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.stem + ".part.npz")
    try:
        np.savez_compressed(tmp, **w, metadata=json.dumps(metadata))
        tmp.replace(path)
    finally:
        tmp.unlink(missing_ok=True)


def load_model(path: Path) -> tuple[dict, dict]:
    with np.load(path, allow_pickle=False) as saved:
        w = {k: np.asarray(saved[k], np.float32)
             for k in ("mean", "scale", "conv_w", "conv_b", "out_w", "out_b")}
        meta = json.loads(str(saved["metadata"]))
    shapes = {
        "mean": (MELS,), "scale": (MELS,),
        "conv_w": (KERNEL * MELS, CHANNELS),
        "conv_b": (CHANNELS,),
        "out_w": (POOL_BINS * CHANNELS, CLASSES),
        "out_b": (CLASSES,),
    }
    if meta.get("version") != MODEL_VERSION or any(
        w[k].shape != dims or not np.isfinite(w[k]).all()
        for k, dims in shapes.items()
    ) or np.any(w["scale"] <= 0):
        raise ValueError("Invalid V4 research-only candidate")
    return w, meta
