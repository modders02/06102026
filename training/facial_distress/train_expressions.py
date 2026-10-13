"""Train a candidate seven-expression face model on authorized labeled images.

Never overwrites or deploys the live browser face-api model. The output ONNX
checkpoint requires independent validation and a later explicit integration.
"""
from __future__ import annotations

import argparse
import copy
import json
import random
from collections import Counter
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from sklearn.metrics import classification_report, confusion_matrix
from torch import nn
from torch.utils.data import DataLoader, Dataset
from torchvision import models, transforms

from import_fer2013 import CLASSES

IMAGE_EXTENSIONS = frozenset({".jpg", ".jpeg", ".png", ".webp"})
SPLITS = ("train", "val", "test")


class ExpressionDataset(Dataset):
    def __init__(self, examples, transform):
        self.examples = examples
        self.transform = transform

    def __len__(self):
        return len(self.examples)

    def __getitem__(self, position):
        path, class_id = self.examples[position]
        with Image.open(path) as image:
            return self.transform(image.convert("RGB")), class_id


def gather_samples(root: Path, minimums=(30, 10, 10)):
    """Require each class in each fixed split; no auto-splitting near-duplicates."""
    examples = {}
    report = {}
    sha_splits = {}
    # FER2013 importer already removes exact duplicate pixels. This also catches
    # accidentally mixed user files copied into val/test after importing.
    for split, minimum in zip(SPLITS, minimums):
        split_data = []
        split_counts = {}
        for index, label in enumerate(CLASSES):
            folder = root / split / label
            images = sorted(
                p for p in folder.iterdir()
                if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS
            ) if folder.is_dir() else []
            if len(images) < minimum:
                raise ValueError(
                    f"{split}/{label}: {len(images)} photos, need at least {minimum}"
                )
            for path in images:
                # Catch identical files across class labels or splits.
                import hashlib
                digest = hashlib.sha256(path.read_bytes()).hexdigest()
                existing = sha_splits.get(digest)
                if existing and existing != f"{split}/{label}":
                    raise ValueError(f"Duplicate image spans labels/splits: {path}")
                sha_splits[digest] = f"{split}/{label}"
                split_data.append((path, index))
            split_counts[label] = len(images)
        examples[split] = split_data
        report[split] = split_counts
    return examples, report


def train_model(args):
    if args.epochs < 1 or args.batch_size < 1 or args.patience < 1:
        raise ValueError("epochs, batch-size and patience must be >= 1")
    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    data, counts = gather_samples(args.data)
    train_aug = transforms.Compose([
        transforms.Resize((256, 256)),
        transforms.RandomResizedCrop(224, scale=(0.85, 1.0)),
        transforms.RandomHorizontalFlip(),
        transforms.ColorJitter(brightness=0.2, contrast=0.2),
        transforms.RandomRotation(7),
        transforms.ToTensor(),
        transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
    ])
    eval_aug = transforms.Compose([
        transforms.Resize((224, 224)),
        transforms.ToTensor(),
        transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
    ])
    loaders = {
        split: DataLoader(ExpressionDataset(samples, train_aug if split == "train" else eval_aug),
                          batch_size=args.batch_size, shuffle=(split == "train"),
                          num_workers=args.workers)
        for split, samples in data.items()
    }
    # Local pre-trained ImageNet weights are downloaded by torchvision only if
    # not already cached. The training photos themselves never leave this PC.
    weights = None if args.no_pretrained else models.MobileNet_V3_Small_Weights.DEFAULT
    model = models.mobilenet_v3_small(weights=weights)
    for parameter in model.features.parameters():
        parameter.requires_grad = False
    for block in list(model.features.children())[-3:]:
        for parameter in block.parameters():
            parameter.requires_grad = True
    model.classifier[-1] = nn.Linear(model.classifier[-1].in_features, len(CLASSES))
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = model.to(device)
    inverse_count = torch.tensor(
        [sum(counts["train"].values()) / (len(CLASSES) * counts["train"][label])
         for label in CLASSES], dtype=torch.float32, device=device
    )
    loss_fn = nn.CrossEntropyLoss(weight=inverse_count)
    optimizer = torch.optim.AdamW(
        (p for p in model.parameters() if p.requires_grad), lr=args.lr,
        weight_decay=1e-4,
    )
    best = float("inf")
    best_state = None
    patience_left = args.patience
    history = []

    def run_epoch(split, optimizer=None):
        model.train(optimizer is not None)
        losses = 0.0
        correct = 0
        processed = 0
        for images, target in loaders[split]:
            images, target = images.to(device), target.to(device)
            if optimizer is not None:
                optimizer.zero_grad(set_to_none=True)
            with torch.set_grad_enabled(optimizer is not None):
                logits = model(images)
                loss = loss_fn(logits, target)
                if optimizer is not None:
                    loss.backward()
                    optimizer.step()
            losses += float(loss.item()) * len(target)
            correct += int((logits.argmax(1) == target).sum().item())
            processed += len(target)
        return losses / processed, correct / processed

    print(f"Device: {device}; classes: {', '.join(CLASSES)}")
    print(json.dumps(counts, indent=2))
    for epoch in range(args.epochs):
        train_loss, train_acc = run_epoch("train", optimizer)
        val_loss, val_acc = run_epoch("val")
        history.append({"epoch": epoch + 1, "train_loss": train_loss,
                        "train_accuracy": train_acc, "val_loss": val_loss,
                        "val_accuracy": val_acc})
        print(f"Epoch {epoch+1}: train={train_acc:.3f}, val={val_acc:.3f}, val_loss={val_loss:.4f}", flush=True)
        if val_loss < best:
            best = val_loss
            best_state = copy.deepcopy(model.state_dict())
            patience_left = args.patience
        else:
            patience_left -= 1
            if patience_left == 0:
                print("Early stopped before overfitting further.")
                break
    if best_state is None:
        raise RuntimeError("No model checkpoint was produced")
    model.load_state_dict(best_state)
    model.eval()
    assessments = {}
    with torch.no_grad():
        for split in ("val", "test"):
            truth, predicted = [], []
            for images, labels in loaders[split]:
                logits = model(images.to(device))
                truth.extend(labels.tolist())
                predicted.extend(logits.argmax(1).cpu().tolist())
            assessments[split] = {
                "report": classification_report(
                    truth, predicted, labels=list(range(len(CLASSES))),
                    target_names=CLASSES, output_dict=True, zero_division=0
                ),
                "confusion": confusion_matrix(truth, predicted,
                                            labels=list(range(len(CLASSES)))).tolist(),
            }
    # No arbitrary automatic production activation based on one metric.
    # Record per-class performance and particularly frightening false positives.
    minimum_recall = min(assessments["test"]["report"][x]["recall"] for x in CLASSES)
    macro_f1 = assessments["test"]["report"]["macro avg"]["f1-score"]
    report = {
        "classes": list(CLASSES), "image_size": 224,
        "source": "FER2013 + any local consented photos, as configured",
        "split_counts": counts, "assessments": assessments,
        "test_minimum_class_recall": minimum_recall,
        "test_macro_f1": macro_f1,
        "history": history, "deployment_ready": False,
        "deployment_note": "Candidate only. Do not activate without external held-out CCTV tests and runtime integration.",
    }
    args.output.mkdir(parents=True, exist_ok=True)
    torch.save({"model_state": best_state, "classes": CLASSES,
                "normalization": "imagenet_rgb_224"}, args.output / "expression_candidate.pt")
    (args.output / "expression_metrics.json").write_text(
        json.dumps(report, indent=2), encoding="utf-8"
    )
    cpu_model = model.to("cpu").eval()
    torch.onnx.export(
        cpu_model, torch.randn(1, 3, 224, 224),
        args.output / "expression_candidate.onnx",
        input_names=["rgb_face_normalized"], output_names=["logits"],
        dynamic_axes={"rgb_face_normalized": {0: "batch"},
                      "logits": {0: "batch"}}, opset_version=17,
    )
    print(f"Candidate exported to: {args.output.resolve()}")
    print(f"Held-out test macro-F1: {macro_f1:.3f}; lowest-class recall: {minimum_recall:.3f}")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=Path("data/expressions"))
    parser.add_argument("--output", type=Path, default=Path("artifacts/expressions"))
    parser.add_argument("--epochs", type=int, default=20)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--workers", type=int, default=0)
    parser.add_argument("--lr", type=float, default=3e-4)
    parser.add_argument("--patience", type=int, default=5)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--no-pretrained", action="store_true",
                        help="Train without ImageNet pretrained weights (not recommended).")
    train_model(parser.parse_args())


if __name__ == "__main__":
    main()
