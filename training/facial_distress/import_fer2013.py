"""Import a locally authorized FER2013 CSV into seven labeled image folders.

FER2013 comes from the original Kaggle competition. This code does NOT
scrape people from the internet or imply that Kaggle grants blanket rights
for every purpose. Review the competition rules before using the dataset.

Split mapping is fixed; PublicTest and PrivateTest are never training data.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
from collections import Counter
from pathlib import Path

from PIL import Image

CLASSES = ("angry", "disgusted", "fearful", "happy", "sad", "surprised", "neutral")
USAGE_SPLITS = {"Training": "train", "PublicTest": "val", "PrivateTest": "test"}
IMAGE_WIDTH = 48
PIXEL_COUNT = IMAGE_WIDTH * IMAGE_WIDTH


def parse_pixels(value: str) -> bytes:
    items = value.split()
    if len(items) != PIXEL_COUNT:
        raise ValueError(f"Expected {PIXEL_COUNT} pixel values, got {len(items)}")
    try:
        numbers = [int(x) for x in items]
    except ValueError as exc:
        raise ValueError("Invalid non-integer pixel") from exc
    if any(n < 0 or n > 255 for n in numbers):
        raise ValueError("Pixel must be in range 0..255")
    return bytes(numbers)


def import_fer2013(csv_path: Path, destination: Path, limit_per_class: int = 0) -> dict:
    if not csv_path.is_file() or not csv_path.name.lower().endswith(".csv"):
        raise ValueError("Supply a local authorized fer2013.csv file.")
    if limit_per_class < 0:
        raise ValueError("limit_per_class cannot be negative")
    counts: Counter[str] = Counter()
    duplicates = 0
    seen: dict[str, str] = {}
    with csv_path.open("r", encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        if not {"emotion", "pixels", "Usage"}.issubset(reader.fieldnames or []):
            raise ValueError("CSV must contain emotion, pixels and Usage columns.")
        for row_index, row in enumerate(reader, 1):
            try:
                label = CLASSES[int(row["emotion"])]
                split = USAGE_SPLITS[row["Usage"]]
            except (ValueError, IndexError, KeyError) as exc:
                raise ValueError(f"Invalid label or Usage in row {row_index}") from exc
            key = f"{split}/{label}"
            if limit_per_class and counts[key] >= limit_per_class:
                continue
            pixels = parse_pixels(row["pixels"])
            digest = hashlib.sha256(pixels).hexdigest()
            # Prevent an identical image appearing in both train and tests,
            # even when the source dataset contains duplicate pixel arrays.
            previous = seen.get(digest)
            if previous is not None:
                duplicates += 1
                continue
            seen[digest] = key
            folder = destination / split / label
            folder.mkdir(parents=True, exist_ok=True)
            path = folder / f"fer{row_index:07d}_{digest[:12]}.png"
            Image.frombytes("L", (IMAGE_WIDTH, IMAGE_WIDTH), pixels).save(path)
            counts[key] += 1
    manifest = {
        "source": "FER2013 Kaggle local import (user must verify permissions)",
        "license_reviewed_by_user": True,
        "classes": list(CLASSES),
        "counts": dict(sorted(counts.items())),
        "duplicates_omitted": duplicates,
        "source_sha256": hashlib.sha256(csv_path.read_bytes()).hexdigest(),
    }
    (destination / "fer2013_import.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--csv", required=True, type=Path)
    parser.add_argument("--output", type=Path, default=Path("data/expressions"))
    parser.add_argument("--limit-per-class", type=int, default=0,
                        help="For quick tests: max N per label per split (0=all)")
    parser.add_argument("--rights-checked", action="store_true", required=True,
                        help="Confirm you reviewed and can use the original Kaggle dataset.")
    args = parser.parse_args()
    result = import_fer2013(args.csv, args.output, args.limit_per_class)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
