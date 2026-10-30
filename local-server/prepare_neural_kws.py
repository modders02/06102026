r"""Prepare the official English sherpa-onnx model and seven MSDS keywords.

Run from the isolated .neural-kws-venv Python interpreter after installing
requirements-neural-kws.txt. This does NOT train or alter the custom DTW engine.
"""
from __future__ import annotations

import argparse
from pathlib import Path
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


def load_vocabulary(tokens_path: Path) -> set[str]:
    """Match sherpa-onnx's vocabulary validation for the English model."""
    vocabulary = set()
    for line in tokens_path.read_text(encoding="utf-8-sig").splitlines():
        if not line.strip():
            continue
        parts = line.split()
        if len(parts) != 2:
            raise ValueError(f"Malformed token-table entry: {line[:80]!r}")
        try:
            int(parts[1])
        except ValueError as exc:
            raise ValueError(f"Non-numeric token ID: {line[:80]!r}") from exc
        if parts[0] in vocabulary:
            raise ValueError(f"Duplicate model token: {parts[0]!r}")
        vocabulary.add(parts[0])
    if not vocabulary:
        raise ValueError("English model token table is empty")
    return vocabulary


def encode_english_keywords(processor, vocabulary: set[str],
                            keywords: tuple[str, ...] = KEYWORDS) -> list[str]:
    """Format English BPE keywords with the normal Sherpa metadata.

    The sherpa-onnx 1.12.26 CLI imports pypinyin for all languages, even for
    English-only BPE. Use SentencePiece directly, then reject tokens absent
    from the official model's tokens.txt. Never silently skip a keyword.
    """
    lines = []
    for word in keywords:
        if not word.isascii() or not word.isalpha() or word.lower() != word:
            raise ValueError(f"Expected lowercase ASCII keyword, got {word!r}")
        pieces = processor.encode(word.upper(), out_type=str)
        if not pieces or any(not isinstance(piece, str) or not piece for piece in pieces):
            raise ValueError(f"SentencePiece returned no valid tokens for {word.upper()}")
        unknown = [piece for piece in pieces if piece not in vocabulary or piece == "<unk>"]
        if unknown:
            raise ValueError(f"Keyword {word.upper()} has out-of-vocabulary BPE tokens: {unknown}")
        lines.append(" ".join((*pieces, ":1.0", "#0.50", f"@{word}")))
    if len(lines) != len(keywords):
        raise RuntimeError("Not all keywords were tokenized")
    return lines


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
    # Sherpa's English BPE tokenizer uses SentencePiece. Avoid its CLI here:
    # sherpa-onnx==1.12.26 imports Chinese pypinyin even with --tokens-type bpe.
    import sentencepiece as spm

    raw.write_text(
        "".join(f"{word.upper()} :1.0 #0.50 @{word}\n" for word in KEYWORDS),
        encoding="utf-8",
    )
    print("[Neural KWS] Building English keyword tokens directly with SentencePiece...", flush=True)
    processor = spm.SentencePieceProcessor(model_file=str(model / "bpe.model"))
    vocabulary = load_vocabulary(model / "tokens.txt")
    lines = encode_english_keywords(processor, vocabulary)
    if len(lines) != len(KEYWORDS) or not all(
        f"@{word}" in line.split() for word, line in zip(KEYWORDS, lines)
    ):
        raise RuntimeError("Keyword tokenization produced invalid or missing labels")
    temp = processed.with_suffix(".txt.part")
    try:
        temp.write_text("\n".join(lines) + "\n", encoding="utf-8")
        temp.replace(processed)
    finally:
        temp.unlink(missing_ok=True)
    for word in KEYWORDS:
        print(f"[Neural KWS] Prepared {word.upper()} (BPE tokens verified)")
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
