"""Download the official FER2013 competition archive with your Kaggle login.

Never scrape search-engine faces or substitute an unverified third-party copy.
Kaggle CLI uses KAGGLE_API_TOKEN or your own ~/.kaggle/kaggle.json.
"""
from __future__ import annotations

import argparse
import csv
import os
import sys
import shutil
import subprocess
import tarfile
import tempfile
import zipfile
from pathlib import Path

COMPETITION = "challenges-in-representation-learning-facial-expression-recognition-challenge"
DATASET_MEMBER = "fer2013/fer2013.csv"
MAX_CSV_BYTES = 500 * 1024 * 1024
EXPECTED_SPLITS = {"Training": 28709, "PublicTest": 3589, "PrivateTest": 3589}
ZIP_NAMES = {DATASET_MEMBER, "fer2013.csv", "fer2013.tar.gz"}


def extract_csv(archive: Path, csv_path: Path) -> Path:
    """Extract only official FER2013 CSV, never archive paths or arbitrary files."""
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as temp_dir:
        staging = Path(temp_dir) / "fer2013.csv"
        if archive.suffix.lower() == ".csv":
            if archive.stat().st_size > MAX_CSV_BYTES:
                raise ValueError("CSV is unexpectedly large")
            shutil.copyfile(archive, staging)
        elif zipfile.is_zipfile(archive):
            with zipfile.ZipFile(archive) as container:
                files = {
                    member.filename: member for member in container.infolist()
                    if not member.is_dir() and member.filename in ZIP_NAMES
                }
                direct = next((files[k] for k in (DATASET_MEMBER,"fer2013.csv") if k in files), None)
                if direct:
                    if direct.file_size > MAX_CSV_BYTES:
                        raise ValueError("CSV exceeds dataset safety limit")
                    with container.open(direct) as source, staging.open("wb") as target:
                        shutil.copyfileobj(source, target)
                elif "fer2013.tar.gz" in files:
                    inner = Path(temp_dir) / "fer2013.tar.gz"
                    with container.open(files["fer2013.tar.gz"]) as source, inner.open("wb") as target:
                        shutil.copyfileobj(source, target)
                    extract_tar_csv(inner, staging)
                else:
                    raise ValueError("Official FER2013 CSV not found in competition ZIP")
        elif tarfile.is_tarfile(archive):
            extract_tar_csv(archive, staging)
        else:
            raise ValueError("Unsupported Kaggle archive; expected ZIP, tar.gz or CSV")
        validate_csv(staging)
        # Replace only after the full CSV has been extracted and validated.
        shutil.copyfile(staging, csv_path)
    return csv_path


def extract_tar_csv(archive: Path, destination: Path):
    with tarfile.open(archive, "r:*") as container:
        matches = [m for m in container.getmembers()
                   if m.isfile() and m.name in (DATASET_MEMBER, "fer2013.csv")]
        if len(matches) != 1:
            raise ValueError("Expected exactly one official fer2013.csv in tar archive")
        member = matches[0]
        if member.size > MAX_CSV_BYTES:
            raise ValueError("FER2013 CSV exceeds safety limit")
        source = container.extractfile(member)
        if source is None:
            raise ValueError("Cannot read FER2013 CSV entry")
        with source, destination.open("wb") as target:
            shutil.copyfileobj(source, target)


def validate_csv(path: Path) -> dict:
    """Check official labels, splits, pixel dimensions and expected row counts."""
    if path.stat().st_size > MAX_CSV_BYTES:
        raise ValueError("CSV exceeds safety limit")
    counts = {key:0 for key in EXPECTED_SPLITS}
    with path.open("r", newline="", encoding="utf-8-sig") as stream:
        reader = csv.DictReader(stream)
        if not {"emotion","pixels","Usage"}.issubset(reader.fieldnames or []):
            raise ValueError("This is not the original FER2013 CSV (needs emotion,pixels,Usage)")
        for row_number, record in enumerate(reader, 1):
            if record.get("Usage") not in counts:
                raise ValueError(f"Unexpected dataset split at row {row_number}")
            try:
                label = int(record["emotion"])
            except (ValueError, TypeError):
                raise ValueError(f"Invalid emotion label at row {row_number}") from None
            if not 0 <= label <= 6:
                raise ValueError(f"Emotion label out of range at row {row_number}")
            # Pixel values are individually validated during image conversion.
            if len((record.get("pixels") or "").split()) != 48*48:
                raise ValueError(f"Unexpected 48x48 pixel count in row {row_number}")
            counts[record["Usage"]] += 1
    if counts != EXPECTED_SPLITS:
        raise ValueError(f"Incomplete or incorrect FER2013 CSV counts: {counts}")
    return counts


def download_official(destination: Path) -> Path:
    """Requires Kaggle account access and competition rules acceptance."""
    destination.mkdir(parents=True, exist_ok=True)
    local_cli = Path(sys.executable).with_name("kaggle.exe" if os.name=="nt" else "kaggle")
    kaggle_executable = str(local_cli) if local_cli.is_file() else "kaggle"
    command = [kaggle_executable,"competitions","download","-c",COMPETITION,
               "-f","fer2013.tar.gz","-p",str(destination)]
    try:
        subprocess.run(command, check=True, timeout=900)
    except FileNotFoundError as exc:
        raise RuntimeError("Install Kaggle CLI: python -m pip install kaggle") from exc
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(
            "Kaggle rejected the download. Sign in, accept the competition "
            "rules, and configure Kaggle CLI credentials locally."
        ) from exc
    candidates = [
        destination / "fer2013.tar.gz",
        destination / "fer2013.tar.gz.zip",
        destination / "fer2013.zip",
    ]
    for item in candidates:
        if item.is_file():
            return item
    raise RuntimeError(f"Kaggle finished but expected FER2013 archive was not found in {destination}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("data/fer2013.csv"))
    parser.add_argument("--archives", type=Path, default=Path("data/downloads"))
    parser.add_argument("--archive", type=Path,
                        help="Previously downloaded official Kaggle fer2013.tar.gz/ZIP/CSV")
    parser.add_argument("--accept-kaggle-terms", action="store_true", required=True,
                        help="Confirm the official competition rules have been reviewed and accepted.")
    args = parser.parse_args()
    archive = args.archive if args.archive else download_official(args.archives)
    path = extract_csv(archive, args.output)
    print(f"FER2013 verified: {path} ({path.stat().st_size:,} bytes).")
    print(f"Original splits: {EXPECTED_SPLITS}")


if __name__ == "__main__":
    main()
