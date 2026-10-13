"""Import explicitly consented, labeled face photos for local model training.

No upload, cloud storage, face identification or background harvesting.
These personal photos go into *train* only; public held-out validation/test
splits are never contaminated by frames from the same capture session.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import cv2

from import_fer2013 import CLASSES

ALLOWED_EXTENSIONS = frozenset({".png", ".jpg", ".jpeg", ".webp"})
MAX_FILE_BYTES = 20 * 1024 * 1024


def import_photos(paths: list[Path], label: str, subject: str, root: Path) -> dict:
    if label not in CLASSES:
        raise ValueError(f"Unknown expression label {label!r}")
    if not subject or len(subject) > 100:
        raise ValueError("Provide a nonempty, short pseudonymous subject ID")
    subject_hash = hashlib.sha256(subject.encode("utf-8")).hexdigest()[:12]
    cascade = cv2.CascadeClassifier(
        cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    )
    if cascade.empty():
        raise RuntimeError("OpenCV frontal-face detector not available.")
    dest = root / "train" / label
    dest.mkdir(parents=True, exist_ok=True)
    saved = []
    skipped = []
    for path in sorted(paths):
        if not path.is_file() or path.suffix.lower() not in ALLOWED_EXTENSIONS:
            skipped.append((path.name, "unsupported_file"))
            continue
        if path.stat().st_size > MAX_FILE_BYTES:
            skipped.append((path.name, "image_too_large"))
            continue
        image = cv2.imread(str(path), cv2.IMREAD_COLOR)
        if image is None:
            skipped.append((path.name, "invalid_image"))
            continue
        if max(image.shape[:2]) > 6000:
            skipped.append((path.name, "image_dimensions_too_large"))
            continue
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        faces = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5,
                                         minSize=(32, 32))
        if len(faces) != 1:
            skipped.append((path.name, f"expected_one_face_found_{len(faces)}"))
            continue
        x, y, width, height = map(int, faces[0])
        margin = int(max(width, height) * 0.12)
        crop = image[
            max(0, y - margin):min(image.shape[0], y + height + margin),
            max(0, x - margin):min(image.shape[1], x + width + margin),
        ]
        if crop.size == 0:
            skipped.append((path.name, "invalid_face_crop"))
            continue
        crop = cv2.resize(crop, (224, 224), interpolation=cv2.INTER_AREA)
        # Stable content filename avoids accidentally accumulating duplicates.
        digest = hashlib.sha256(crop.tobytes()).hexdigest()[:16]
        filename = f"consented_{subject_hash}_{digest}.png"
        output = dest / filename
        if output.exists():
            skipped.append((path.name, "duplicate_image"))
            continue
        if not cv2.imwrite(str(output), crop):
            raise RuntimeError(f"Could not save {output}")
        saved.append(filename)

    return {"label": label, "subject_id_hash": subject_hash,
            "accepted": len(saved), "skipped": skipped, "files": saved,
            "storage": "local_only", "split": "train"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", type=Path, action="append", default=[],
                        help="Repeat --file for multiple pictures")
    parser.add_argument("--folder", type=Path,
                        help="Folder with labeled photos for one expression")
    parser.add_argument("--label", choices=CLASSES, required=True)
    parser.add_argument("--subject-id", required=True,
                        help="Pseudonym for the consenting subject")
    parser.add_argument("--output", type=Path, default=Path("data/expressions"))
    parser.add_argument("--consent-confirmed", action="store_true", required=True,
                        help="You have each depicted person's explicit consent.")
    args = parser.parse_args()

    candidates = list(args.file)
    if args.folder:
        if not args.folder.is_dir():
            parser.error("--folder must be an existing local directory")
        candidates.extend(args.folder.iterdir())
    if not candidates:
        parser.error("Provide at least one --file or --folder")
    print(json.dumps(import_photos(candidates, args.label, args.subject_id,
                                   args.output), indent=2))


if __name__ == "__main__":
    main()
