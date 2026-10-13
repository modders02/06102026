"""Preview an experimental local seven-expression checkpoint on one own photo.

Never publishes an alert, stores a face identity, or modifies the MSDS camera.
Only run with an explicitly trusted checkpoint trained on authorized photos.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np
import torch
from PIL import Image
from torchvision import models, transforms

from import_fer2013 import CLASSES

PREPROCESS = transforms.Compose([
    transforms.Resize((224, 224)),
    transforms.ToTensor(),
    transforms.Normalize([0.485, 0.456, 0.406],
                         [0.229, 0.224, 0.225]),
])


def preview(image_path: Path, checkpoint_path: Path):
    if not image_path.is_file():
        raise ValueError(f"Image not found: {image_path}")
    if not checkpoint_path.is_file():
        raise ValueError("Train a local candidate first; checkpoint not found.")
    image = cv2.imread(str(image_path))
    if image is None:
        raise ValueError("Could not decode image")
    if max(image.shape[:2]) > 6000:
        raise ValueError("Image dimensions are too large")
    detector = cv2.CascadeClassifier(
        cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    )
    if detector.empty():
        raise RuntimeError("Could not load face detector")
    faces = detector.detectMultiScale(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY),
                                     scaleFactor=1.1, minNeighbors=5,
                                     minSize=(32, 32))
    if len(faces) != 1:
        raise ValueError(f"Expected exactly one visible face; found {len(faces)}")
    x, y, w, h = map(int, faces[0])
    margin = int(max(w, h) * 0.12)
    crop = image[max(0,y-margin):min(image.shape[0],y+h+margin),
                 max(0,x-margin):min(image.shape[1],x+w+margin)]
    rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
    model = models.mobilenet_v3_small(weights=None)
    model.classifier[-1] = torch.nn.Linear(
        model.classifier[-1].in_features, len(CLASSES)
    )
    state = torch.load(checkpoint_path, map_location="cpu", weights_only=True)
    if tuple(state.get("classes", ())) != CLASSES:
        raise ValueError("Incompatible label map or checkpoint")
    model.load_state_dict(state["model_state"], strict=True)
    model.eval()
    with torch.no_grad():
        values = model(PREPROCESS(Image.fromarray(rgb)).unsqueeze(0))
        probabilities = torch.softmax(values[0], dim=0).numpy()
    ranked = sorted(zip(CLASSES, probabilities.tolist()),
                    key=lambda item: item[1], reverse=True)
    return {
        "candidate_prediction": ranked[0][0],
        "candidate_score": round(ranked[0][1], 4),
        "scores": {k: round(float(v), 4) for k, v in ranked},
        "not_for_safety_alerts": True,
        "note": "Facial expression is an observed appearance, not verified inner emotion.",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", type=Path, required=True)
    parser.add_argument("--model", type=Path,
                        default=Path("artifacts/expressions/expression_candidate.pt"))
    args = parser.parse_args()
    print(json.dumps(preview(args.image, args.model), indent=2))


if __name__ == "__main__":
    main()
