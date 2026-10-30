r"""Prepare the official English sherpa-onnx model and seven MSDS keywords.

Run from the isolated .neural-kws-venv Python interpreter after installing
requirements-neural-kws.txt. This does NOT train or alter the custom DTW engine.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parent
MODEL_NAME = "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01"
RELEASE_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/"
    + MODEL_NAME + ".tar.bz2"
)
KEYWORDS = ("help", "fire", "emergency", "danger", "intruder", "police", "ambulance")
MAX_ARCHIVE_BYTES = 90 * 1024 * 1024
MAX_MEMBER_BYTES = 50 * 1024 * 1024
MODEL_STEMS = (
    "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
    "decoder-epoch-12-avg-2-chunk-16-left-64.onnx",
    "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
    "tokens.txt", "bpe.model",
)


def expected_model_files(model: Path):
    return tuple(model / file for file in MODEL_STEMS)


def safe_members(archive: tarfile.TarFile):
    """Reject absolute paths, traversal, links, or unexpectedly large files."""
    members = archive.getmembers()
    for member in members:
        path = Path(member.name.replace("\\", "/"))
        if path.is_absolute() or ".." in path.parts or path.parts[0] != MODEL_NAME:
            raise ValueError("Model archive contains an unsafe path")
        if not (member.isfile() or member.isdir()):
            raise ValueError("Model archive contains a link or special member")
        if member.size < 0 or member.size > MAX_MEMBER_BYTES:
            raise ValueError("Model archive has an unexpectedly large member")
    return members


def download_archive(destination: Path):
    destination.parent.mkdir(parents=True, exist_ok=True)
    temp = destination.with_suffix(destination.suffix + ".part")
    print("[Neural KWS] Downloading official English Zipformer model archive...", flush=True)
    try:
        with urllib.request.urlopen(RELEASE_URL, timeout=60) as response, temp.open("wb") as out:
            size = 0
            while True:
                chunk = response.read(65536)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_ARCHIVE_BYTES:
                    raise ValueError("Model archive exceeds allowed size")
                out.write(chunk)
        if not size:
            raise ValueError("Empty downloaded archive")
        temp.replace(destination)
    finally:
        temp.unlink(missing_ok=True)


def cli_path() -> Path:
    home = Path(sys.executable).resolve().parent
    for candidate in ("sherpa-onnx-cli.exe", "sherpa-onnx-cli"):
        path = home / candidate
        if path.exists():
            return path
    raise RuntimeError("Cannot find sherpa-onnx-cli in this Python venv. Install requirements-neural-kws.txt first.")


def prepare(root: Path = ROOT, download: bool = True) -> Path:
    models = root / "neural-kws-models"
    model = models / MODEL_NAME
    if not all(p.is_file() and p.stat().st_size > 0 for p in expected_model_files(model)):
        if not download:
            raise FileNotFoundError(f"Model is missing at: {model}")
        archive_path = models / (MODEL_NAME + ".tar.bz2")
        if not archive_path.is_file():
            download_archive(archive_path)
        print("[Neural KWS] Extracting official model archive...", flush=True)
        try:
            with tarfile.open(archive_path, "r:bz2") as tar:
                members = safe_members(tar)
                # Member types and paths were checked above.
                tar.extractall(models, members=members, filter="data")
        finally:
            # Keep a downloaded archive only if extraction failed, to allow retry.
            if all(p.is_file() for p in expected_model_files(model)):
                archive_path.unlink(missing_ok=True)
        if not all(p.is_file() and p.stat().st_size > 0 for p in expected_model_files(model)):
            raise RuntimeError("The downloaded model is incomplete; check the archive.")
    raw = models / "msds_keywords_raw.txt"
    processed = models / "msds_keywords.txt"
    # @label ensures the resulting keyword text maps cleanly to the MSDS keys.
    # Start conservatively; adjust thresholds only after measuring false alarms.
    raw.write_text("".join(f"{word.upper()} :1.0 #0.50 @{word}\n" for word in KEYWORDS), encoding="utf-8")
    cmd = [
        str(cli_path()), "text2token", "--tokens", str(model / "tokens.txt"),
        "--tokens-type", "bpe", "--bpe-model", str(model / "bpe.model"),
        str(raw), str(processed),
    ]
    print("[Neural KWS] Building English keyword tokens...", flush=True)
    # Invoke Click-based sherpa-onnx CLI with Unicode support regardless of
    # a legacy cp1252 Windows console (the CLI emits BPE/CJK examples).
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    result = subprocess.run(
        cmd, capture_output=True, text=True, encoding="utf-8",
        errors="replace", env=env,
    )
    if result.returncode != 0:
        raise RuntimeError("Keyword tokenization failed: " + (result.stderr or result.stdout)[-1200:])
    lines = [line.strip() for line in processed.read_text(encoding="utf-8-sig").splitlines() if line.strip()]
    if len(lines) != len(KEYWORDS):
        raise RuntimeError(f"Expected {len(KEYWORDS)} keyword lines, got {len(lines)}")
    for word, line in zip(KEYWORDS, lines):
        if f"@{word}" not in line:
            raise RuntimeError(f"Keyword tokenizer did not preserve @{word}: {line!r}")
    print(f"[Neural KWS] Ready: {model}")
    print("[Neural KWS] Seven keywords prepared; no DTW templates were modified.")
    return model


def main():
    parser = argparse.ArgumentParser(description="Download offline neural-KWS model and prepare keywords.")
    parser.add_argument("--no-download", action="store_true")
    args = parser.parse_args()
    prepare(download=not args.no_download)


if __name__ == "__main__":
    main()
