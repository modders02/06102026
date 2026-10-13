"""Import FER2013 train/test image-folder ZIP with safe held-out splits.

Accepts the Kaggle image-folder variant (train/*/Training_*.jpg and
test/*/{PublicTest,PrivateTest}_*.jpg) or the cleaned variant produced here.
It preserves PublicTest as validation, PrivateTest as untouched test, and
removes exact-byte duplicates across splits/classes. Conflicting labels
for the same image are excluded rather than assigned arbitrarily.
"""
from __future__ import annotations
import argparse
import collections
import hashlib
import io
import json
import zipfile
from pathlib import Path
from PIL import Image

LABEL_MAP = {
    "angry": "angry", "disgust": "disgusted",
    "disgusted": "disgusted", "fear": "fearful",
    "fearful": "fearful", "happy": "happy", "sad": "sad",
    "surprise": "surprised", "surprised": "surprised",
    "neutral": "neutral",
}
SPLIT_RANK = {"test": 0, "val": 1, "train": 2}


def dataset_entry(name: str):
    parts = name.split("/")
    if len(parts) != 3 or parts[1] not in LABEL_MAP:
        raise ValueError(f"Unexpected FER2013 dataset file: {name}")
    folder, raw_label, basename = parts
    if not basename.lower().endswith((".jpg", ".jpeg", ".png")):
        raise ValueError(f"Unexpected FER2013 image extension: {name}")
    prefix = basename.split("_", 1)[0]
    if folder == "train" and prefix == "Training":
        split = "train"
    elif folder == "test" and prefix == "PublicTest":
        split = "val"
    elif folder == "test" and prefix == "PrivateTest":
        split = "test"
    elif folder in ("train", "val", "test") and prefix in (
        "Training", "PublicTest", "PrivateTest"
    ):
        split = folder
    else:
        raise ValueError(f"Unexpected FER2013 split filename: {name}")
    return split, LABEL_MAP[raw_label], basename


def import_zip(archive: Path, root: Path, cleaned_zip: Path | None = None):
    if not zipfile.is_zipfile(archive):
        raise ValueError("Expected FER2013 image-folder ZIP, not a CSV/tar file.")
    archive_sha256 = hashlib.sha256(archive.read_bytes()).hexdigest()
    # Prevent old images from mixing with a different dataset import.
    manifest_path = root / "dataset_manifest.json"
    if root.exists() and any(root.iterdir()):
        if manifest_path.exists():
            existing = json.loads(manifest_path.read_text(encoding="utf-8"))
            if existing.get("source_sha256") == archive_sha256:
                print(f"Existing matching prepared dataset: {root}")
                if cleaned_zip is None or cleaned_zip.exists():
                    return existing
        raise ValueError(
            f"Output directory not empty: {root}. Choose a new --output; "
            "do not mix experiments or delete participant photos."
        )
    matches = collections.defaultdict(list)
    original = collections.Counter()
    with zipfile.ZipFile(archive) as source:
        for info in source.infolist():
            if info.is_dir() or info.filename == "dataset_manifest.json":
                continue
            if info.file_size > 1000000:
                raise ValueError(f"Oversize FER2013 face: {info.filename}")
            split, label, basename = dataset_entry(info.filename)
            raw = source.read(info)
            with Image.open(io.BytesIO(raw)) as face:
                if face.size != (48, 48) or face.mode != "L":
                    raise ValueError(f"Unexpected FER2013 grayscale face: {info.filename}")
                face.verify()
            digest = hashlib.sha256(raw).hexdigest()
            matches[digest].append((info.filename, split, label, basename))
            original[f"{split}/{label}"] += 1

        conflicts = {
            digest for digest, variants in matches.items()
            if len({item[2] for item in variants}) > 1
        }
        retained = []
        for digest, variants in matches.items():
            if digest in conflicts:
                continue
            retained.append(min(
                variants,
                key=lambda item: (SPLIT_RANK[item[1]], item[0])
            ))
        retained.sort(key=lambda item: (SPLIT_RANK[item[1]], item[2], item[0]))
        clean = collections.Counter(f"{item[1]}/{item[2]}" for item in retained)
        total = sum(original.values())
        manifest = {
            "dataset": "FER2013 image-folder archive",
            "source_sha256": archive_sha256,
            "source_image_count": total,
            "clean_image_count": len(retained),
            "duplicate_extra_files": sum(len(v) - 1 for v in matches.values()),
            "conflicting_label_groups_excluded": len(conflicts),
            "images_excluded_due_to_label_conflicts": sum(
                len(matches[digest]) for digest in conflicts
            ),
            "removed_total": total - len(retained),
            "source_counts": dict(sorted(original.items())),
            "clean_counts": dict(sorted(clean.items())),
            "class_names": [
                "angry", "disgusted", "fearful", "happy",
                "sad", "surprised", "neutral"
            ],
            "split_mapping": {
                "Training": "train", "PublicTest": "val",
                "PrivateTest": "test"
            },
            "notes": (
                "Exact identical JPEG bytes are deduplicated; same-class "
                "duplicates prefer test > val > train. Near duplicates "
                "and participant identity overlap are not filtered."
            ),
        }
        root.mkdir(parents=True, exist_ok=True)
        if cleaned_zip:
            cleaned_zip.parent.mkdir(parents=True, exist_ok=True)
        output_zip = zipfile.ZipFile(
            cleaned_zip, "w", compression=zipfile.ZIP_STORED
        ) if cleaned_zip else None
        try:
            for original_path, split, label, basename in retained:
                raw = source.read(original_path)
                relative = f"{split}/{label}/{basename}"
                dest = root / split / label / basename
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(raw)
                if output_zip:
                    output_zip.writestr(relative, raw)
            manifest_text = json.dumps(manifest, indent=2) + "\n"
            manifest_path.write_text(manifest_text, encoding="utf-8")
            if output_zip:
                output_zip.writestr("dataset_manifest.json", manifest_text)
        finally:
            if output_zip:
                output_zip.close()
    print(json.dumps(manifest, indent=2))
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=Path("data/fer2013_cleaned"))
    parser.add_argument("--cleaned-zip", type=Path)
    parser.add_argument("--rights-checked", action="store_true", required=True)
    args = parser.parse_args()
    import_zip(args.archive, args.output, args.cleaned_zip)


if __name__ == "__main__":
    main()
