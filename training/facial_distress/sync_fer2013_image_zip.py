"""Upload/restore a prepared FER2013 image ZIP to private Supabase Storage.

A dataset is stored as 4 MiB authenticated shards, with SHA256 integrity and
a manifest published only after successful completion. Upload never publishes
anonymously and never uses frontend or publishable credentials.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import tempfile
from pathlib import Path
from zipfile import ZipFile

BUCKET = "msds-emotion-training"
CHUNK_SIZE = 4 * 1024 * 1024


def sha256_file(path: Path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(CHUNK_SIZE):
            digest.update(chunk)
    return digest.hexdigest()


def validate_archive(path: Path):
    with ZipFile(path) as archive:
        names = archive.namelist()
        if "dataset_manifest.json" not in names:
            raise ValueError("Use the FER2013 prepared ZIP made by import_folder_fer2013.py")
        manifest = json.loads(archive.read("dataset_manifest.json"))
        if manifest.get("dataset") != "FER2013 image-folder archive":
            raise ValueError("Expected an authorized FER2013 image-folder archive")
        counts = {"train": 0, "val": 0, "test": 0}
        for name in names:
            if name == "dataset_manifest.json":
                continue
            parts = name.split("/")
            if len(parts) != 3 or parts[0] not in counts or not parts[-1].lower().endswith((".jpg",".jpeg",".png")):
                raise ValueError("Unexpected file in FER2013 ZIP")
            counts[parts[0]] += 1
        if sum(counts.values()) != manifest.get("clean_image_count"):
            raise ValueError("FER2013 image count does not match manifest")
    return manifest


def server_storage():
    from supabase import create_client
    url = os.environ.get("SUPABASE_URL", "").strip()
    secret = (os.environ.get("SUPABASE_SECRET_KEY") or os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    if not url or not secret:
        raise RuntimeError("Set SUPABASE_URL and SUPABASE_SECRET_KEY on your own PC.")
    return create_client(url, secret).storage.from_(BUCKET)


def check_prefix(value: str):
    if not value or len(value) > 50 or not all(
        char.isascii() and (char.isalnum() or char in "_-") for char in value
    ):
        raise ValueError("Prefix must contain ASCII alphanumeric characters, '-' or '_'")
    return value


def upload(zip_file: Path, prefix: str, store):
    check_prefix(prefix)
    metadata = validate_archive(zip_file)
    digest = sha256_file(zip_file)
    entries = []
    with zip_file.open("rb") as src:
        for index, chunk in enumerate(iter(lambda:src.read(CHUNK_SIZE), b"")):
            name = f"{prefix}/image-folder-fer2013/{digest[:16]}/part_{index:04d}.bin"
            store.upload(name, chunk, {
                "content-type": "application/octet-stream", "upsert": "true"
            })
            entries.append({
                "key": name, "bytes": len(chunk),
                "sha256": hashlib.sha256(chunk).hexdigest()
            })
            print(f"Uploaded shard {index+1}: {len(chunk):,} bytes", flush=True)
    overall = {
        "dataset": metadata["dataset"], "clean_image_count": metadata["clean_image_count"],
        "source_sha256": metadata.get("source_sha256"),
        "zip_sha256": digest, "zip_bytes": zip_file.stat().st_size,
        "entries": entries,
    }
    store.upload(
        f"{prefix}/image-folder-fer2013/manifest.json",
        json.dumps(overall, indent=2).encode("utf-8"),
        {"content-type": "application/json", "upsert": "true"}
    )
    print(f"Uploaded verified FER2013 ZIP in {len(entries)} private shards")
    return overall


def download(destination: Path, prefix: str, store):
    check_prefix(prefix)
    overall = json.loads(store.download(f"{prefix}/image-folder-fer2013/manifest.json").decode())
    entries = overall.get("entries", [])
    if overall.get("dataset") != "FER2013 image-folder archive" or not 1 <= len(entries) <= 100:
        raise ValueError("Invalid FER2013 dataset manifest")
    checksum = overall.get("zip_sha256", "")
    with tempfile.TemporaryDirectory(prefix="fer2013-images-") as workspace:
        temp = Path(workspace) / "images.zip"
        with temp.open("wb") as stream:
            for index, part in enumerate(entries):
                path = f"{prefix}/image-folder-fer2013/{checksum[:16]}/part_{index:04d}.bin"
                if part.get("key") != path:
                    raise ValueError("Dataset path mismatch")
                data = store.download(path)
                if len(data) != part["bytes"] or hashlib.sha256(data).hexdigest() != part["sha256"]:
                    raise ValueError("Dataset shard corruption")
                stream.write(data)
        if sha256_file(temp) != checksum or temp.stat().st_size != overall["zip_bytes"]:
            raise ValueError("Dataset archive checksum mismatch")
        validate_archive(temp)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(temp.read_bytes())
    print(f"Restored dataset to {destination}")
    return overall


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["upload", "download"])
    parser.add_argument("--zip", type=Path, default=Path("data/fer2013_cleaned.zip"))
    parser.add_argument("--prefix", default="research_v1")
    parser.add_argument("--confirm-authorized-images", action="store_true", required=True)
    args = parser.parse_args()
    storage = server_storage()
    if args.action == "upload":
        upload(args.zip, args.prefix, storage)
    else:
        download(args.zip, args.prefix, storage)


if __name__ == "__main__":
    main()
