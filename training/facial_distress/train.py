"""Train and evaluate a three-class facial-distress classifier.

The script uses ImageNet-pretrained MobileNetV3-Small, freezes most of the
backbone for a stable first-stage fine-tune, performs deterministic stratified
train/validation/test splits, saves the best checkpoint, and exports ONNX.
"""
from __future__ import annotations

import argparse
import copy
import json
import random
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import torch
from PIL import Image
from sklearn.metrics import classification_report, confusion_matrix
from sklearn.model_selection import train_test_split
from torch import nn
from torch.utils.data import DataLoader, Dataset
from torchvision import models, transforms

LABELS = ("normal", "mild_distress", "severe_distress")
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}


class FaceDataset(Dataset):
    def __init__(self, samples, transform):
        self.samples = samples
        self.transform = transform

    def __len__(self):
        return len(self.samples)

    def __getitem__(self, index):
        path, label = self.samples[index]
        image = Image.open(path).convert("RGB")
        return self.transform(image), label


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", default="data/raw")
    parser.add_argument("--output", default="artifacts")
    parser.add_argument("--epochs", type=int, default=20)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--lr", type=float, default=3e-4)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--workers", type=int, default=0)
    parser.add_argument("--patience", type=int, default=5)
    return parser.parse_args()


def seed_everything(seed):
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def collect_samples(root: Path):
    samples = []
    counts = {}
    for label_id, label in enumerate(LABELS):
        folder = root / label
        files = sorted(
            path for path in folder.glob("*")
            if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS
        ) if folder.exists() else []
        counts[label] = len(files)
        samples.extend((path, label_id) for path in files)

    missing = [label for label, count in counts.items() if count < 20]
    if missing:
        raise RuntimeError(
            "Each class needs at least 20 images before training. "
            f"Insufficient: {', '.join(missing)}. Counts: {counts}"
        )
    return samples, counts


def split_samples(samples, seed):
    paths = np.array([str(path) for path, _ in samples])
    labels = np.array([label for _, label in samples])

    train_paths, temp_paths, train_y, temp_y = train_test_split(
        paths, labels, test_size=0.30, random_state=seed, stratify=labels
    )
    val_paths, test_paths, val_y, test_y = train_test_split(
        temp_paths, temp_y, test_size=0.50, random_state=seed, stratify=temp_y
    )

    def pair(ps, ys):
        return [(Path(path), int(label)) for path, label in zip(ps, ys)]

    return pair(train_paths, train_y), pair(val_paths, val_y), pair(test_paths, test_y)


def build_model():
    weights = models.MobileNet_V3_Small_Weights.DEFAULT
    model = models.mobilenet_v3_small(weights=weights)

    # Fine-tune the final feature blocks and classifier. Earlier layers stay
    # frozen to reduce overfitting on a small custom research dataset.
    for parameter in model.features.parameters():
        parameter.requires_grad = False
    for block in list(model.features.children())[-3:]:
        for parameter in block.parameters():
            parameter.requires_grad = True

    in_features = model.classifier[-1].in_features
    model.classifier[-1] = nn.Linear(in_features, len(LABELS))
    return model


def make_transforms():
    train_tf = transforms.Compose([
        transforms.Resize((256, 256)),
        transforms.RandomResizedCrop(224, scale=(0.82, 1.0)),
        transforms.RandomHorizontalFlip(),
        transforms.ColorJitter(brightness=0.20, contrast=0.20, saturation=0.10),
        transforms.RandomRotation(8),
        transforms.ToTensor(),
        transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
    ])
    eval_tf = transforms.Compose([
        transforms.Resize((224, 224)),
        transforms.ToTensor(),
        transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
    ])
    return train_tf, eval_tf


def run_epoch(model, loader, criterion, device, optimizer=None):
    training = optimizer is not None
    model.train(training)
    total_loss = 0.0
    correct = 0
    total = 0

    for images, labels in loader:
        images = images.to(device)
        labels = labels.to(device)
        if training:
            optimizer.zero_grad(set_to_none=True)

        logits = model(images)
        loss = criterion(logits, labels)

        if training:
            loss.backward()
            optimizer.step()

        total_loss += loss.item() * labels.size(0)
        correct += (logits.argmax(dim=1) == labels).sum().item()
        total += labels.size(0)

    return total_loss / max(total, 1), correct / max(total, 1)


@torch.inference_mode()
def predict(model, loader, device):
    model.eval()
    truth, predictions = [], []
    for images, labels in loader:
        logits = model(images.to(device))
        truth.extend(labels.numpy().tolist())
        predictions.extend(logits.argmax(dim=1).cpu().numpy().tolist())
    return truth, predictions


def save_confusion_matrix(matrix, output: Path):
    fig, ax = plt.subplots(figsize=(6, 5))
    image = ax.imshow(matrix)
    ax.set_xticks(range(len(LABELS)), LABELS, rotation=30, ha="right")
    ax.set_yticks(range(len(LABELS)), LABELS)
    ax.set_xlabel("Predicted")
    ax.set_ylabel("Actual")
    ax.set_title("Facial distress confusion matrix")
    for row in range(matrix.shape[0]):
        for col in range(matrix.shape[1]):
            ax.text(col, row, str(matrix[row, col]), ha="center", va="center")
    fig.colorbar(image, ax=ax)
    fig.tight_layout()
    fig.savefig(output, dpi=160)
    plt.close(fig)


def main():
    args = parse_args()
    seed_everything(args.seed)

    data_root = Path(args.data)
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)

    samples, counts = collect_samples(data_root)
    train_samples, val_samples, test_samples = split_samples(samples, args.seed)
    train_tf, eval_tf = make_transforms()

    loaders = {
        "train": DataLoader(
            FaceDataset(train_samples, train_tf),
            batch_size=args.batch_size,
            shuffle=True,
            num_workers=args.workers,
        ),
        "val": DataLoader(
            FaceDataset(val_samples, eval_tf),
            batch_size=args.batch_size,
            shuffle=False,
            num_workers=args.workers,
        ),
        "test": DataLoader(
            FaceDataset(test_samples, eval_tf),
            batch_size=args.batch_size,
            shuffle=False,
            num_workers=args.workers,
        ),
    }

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Device: {device}")
    print(f"Dataset counts: {counts}")
    print(
        f"Split: train={len(train_samples)}, val={len(val_samples)}, "
        f"test={len(test_samples)}"
    )

    model = build_model().to(device)
    criterion = nn.CrossEntropyLoss()
    optimizer = torch.optim.AdamW(
        (parameter for parameter in model.parameters() if parameter.requires_grad),
        lr=args.lr,
        weight_decay=1e-4,
    )

    best_state = None
    best_val_loss = float("inf")
    stale_epochs = 0
    history = []

    for epoch in range(1, args.epochs + 1):
        train_loss, train_acc = run_epoch(
            model, loaders["train"], criterion, device, optimizer
        )
        val_loss, val_acc = run_epoch(
            model, loaders["val"], criterion, device
        )
        history.append({
            "epoch": epoch,
            "train_loss": train_loss,
            "train_accuracy": train_acc,
            "val_loss": val_loss,
            "val_accuracy": val_acc,
        })
        print(
            f"Epoch {epoch:02d}: "
            f"train loss={train_loss:.4f} acc={train_acc:.3f} | "
            f"val loss={val_loss:.4f} acc={val_acc:.3f}"
        )

        if val_loss < best_val_loss:
            best_val_loss = val_loss
            best_state = copy.deepcopy(model.state_dict())
            stale_epochs = 0
        else:
            stale_epochs += 1
            if stale_epochs >= args.patience:
                print("Early stopping.")
                break

    if best_state is None:
        raise RuntimeError("Training did not produce a checkpoint.")

    model.load_state_dict(best_state)
    torch.save({
        "model_state": best_state,
        "labels": LABELS,
        "image_size": 224,
    }, output / "facial_distress_mobilenetv3.pt")

    truth, predictions = predict(model, loaders["test"], device)
    report = classification_report(
        truth,
        predictions,
        target_names=LABELS,
        output_dict=True,
        zero_division=0,
    )
    matrix = confusion_matrix(truth, predictions, labels=list(range(len(LABELS))))

    metrics = {
        "labels": LABELS,
        "dataset_counts": counts,
        "train_samples": len(train_samples),
        "validation_samples": len(val_samples),
        "test_samples": len(test_samples),
        "device": str(device),
        "classification_report": report,
        "confusion_matrix": matrix.tolist(),
        "history": history,
    }
    (output / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    save_confusion_matrix(matrix, output / "confusion_matrix.png")

    # Export a CPU copy for runtime integration.
    cpu_model = model.to("cpu").eval()
    dummy = torch.randn(1, 3, 224, 224)
    torch.onnx.export(
        cpu_model,
        dummy,
        output / "facial_distress_mobilenetv3.onnx",
        input_names=["input"],
        output_names=["logits"],
        dynamic_axes={"input": {0: "batch"}, "logits": {0: "batch"}},
        opset_version=17,
    )

    accuracy = report.get("accuracy", 0.0)
    macro_f1 = report.get("macro avg", {}).get("f1-score", 0.0)
    print(f"Test accuracy: {accuracy:.3f}")
    print(f"Macro F1: {macro_f1:.3f}")
    print(f"Artifacts written to: {output.resolve()}")


if __name__ == "__main__":
    main()
