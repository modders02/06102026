"""Research-only, CPU Whisper English ASR benchmark of NEW, consented CCTV WAVs.

V4.1 accepted only 4/35 and pretrained Sherpa V5 only 3/35 on this already
examined dataset. This V6 baseline transcribes each COMPLETE clip with a
fixed pretrained Whisper base.en ASR model and checks exact English words.
It is NOT deployed, trained, tuned or connected to operational alerts.

Each 55-WAV evaluation is explicitly exploratory. Do NOT reuse its numbers
as a sealed final test for choosing a production model.
"""
from __future__ import annotations

import argparse
import csv
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import re
import sys
import wave

import numpy as np

HERE = Path(__file__).resolve().parent
DEFAULT_DATA = HERE / "neural-kws-data"
DEFAULT_MODEL_CACHE = HERE / "neural-kws-models" / "whisper-v6"
MODEL_ID = "base.en"  # Frozen; don't select variants using the 55 reviewed WAVs.
LABELS = (
    "help", "fire", "emergency", "danger", "intruder", "police", "ambulance",
    "unknown",
)
POSITIVE_LABELS = frozenset(LABELS) - {"unknown"}
REPORT_NAME = "whisper_base_en_v6.offline-benchmark.json"
SAMPLE_RATE = 16000
MAX_WAV_SIZE = 6 * 1024 * 1024
_TRANSCRIPT_TOKENS = re.compile(r"[a-z]+")


def keyword_events(transcript: str) -> list[str]:
    """Literal whole English word spotting: no substring or fuzzy guessing."""
    words = _TRANSCRIPT_TOKENS.findall(transcript.lower())
    return [word for word in words if word in POSITIVE_LABELS]


def score_transcripts(rows: list[dict]) -> dict:
    """Correct only if the expected keyword appeared, with no wrong keyword.

    UNKNOWN with ANY detected keyword is one false-positive recording.
    Label is not provided to the transcriber or keyword extraction.
    """
    by_label = {}
    for label in LABELS:
        group = [r for r in rows if r["expected"] == label]
        if not group:
            raise ValueError(f"No WAV for {label}")
        for row in group:
            events = row["keyword_events"]
            row["correct_accepted"] = (
                not events if label == "unknown"
                else bool(events) and all(e == label for e in events)
            )
        by_label[label] = {
            "count": len(group),
            "accepted_correct": sum(bool(r["correct_accepted"]) for r in group),
            "detected_at_least_one": sum(bool(r["keyword_events"]) for r in group),
            "wrong_keyword_events": sum(
                sum(e != label for e in r["keyword_events"]) for r in group
            ),
            "multiple_keyword_events": sum(len(r["keyword_events"]) > 1 for r in group),
        }

    positives = [r for r in rows if r["expected"] != "unknown"]
    unknown = [r for r in rows if r["expected"] == "unknown"]
    correct = sum(bool(r["correct_accepted"]) for r in positives)
    false_positive_files = sum(bool(r["keyword_events"]) for r in unknown)
    return {
        "positive_wavs": len(positives),
        "unknown_wavs": len(unknown),
        "correctly_accepted_positive_wavs": correct,
        "accepted_positive_recall": round(correct / len(positives), 4),
        "unknown_false_positive_count": false_positive_files,
        "unknown_false_positive_fraction": round(false_positive_files / len(unknown), 4),
        "keyword_event_count": sum(len(r["keyword_events"]) for r in rows),
        "per_label": by_label,
        "per_file": rows,
    }


def check_dataset(root: Path, test_root: Path, manifest: Path) -> tuple[list[tuple[str, Path, str]], str]:
    """Check exact train-data SHA duplicates and same-test duplicates."""
    root, test_root, manifest = root.resolve(), test_root.resolve(), manifest.resolve()
    if root == test_root:
        raise ValueError("Test root cannot be training data root")
    try:
        rel = test_root.relative_to(root)
        if not rel.parts or rel.parts[0].lower() in {
            "train", "holdout", "staging", "capture-pilot",
            "quarantine", "noise", "artifacts",
        }:
            raise ValueError("Test root is training/legacy or private artifact data")
    except ValueError as exc:
        if "Test root" in str(exc):
            raise
        # A standalone external absolute directory is also allowed.
    if not manifest.is_file():
        raise FileNotFoundError(f"Missing original training manifest: {manifest}")
    with manifest.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        if tuple(reader.fieldnames or ()) != (
            "relative_path", "speaker_id", "session_id", "sha256"
        ):
            raise ValueError("Unexpected original training manifest columns")
        manifest_rows = list(reader)
    if not manifest_rows:
        raise ValueError("Empty training manifest")
    training_hashes = set()
    for row in manifest_rows:
        val = row["sha256"]
        if not re.fullmatch(r"[a-f0-9]{64}", val):
            raise ValueError("Invalid original training manifest SHA256")
        training_hashes.add(val)

    rows, seen = [], set()
    for label in LABELS:
        folder = test_root / "train" / label
        if not folder.is_dir() or folder.is_symlink():
            raise ValueError(f"Missing or unsafe labeled folder: {folder}")
        paths = sorted(p for p in folder.iterdir() if p.suffix.lower() == ".wav")
        if not paths:
            raise ValueError(f"Missing WAV for {label}")
        for path in paths:
            if not path.is_file() or path.is_symlink() or path.stat().st_size > MAX_WAV_SIZE:
                raise ValueError(f"Unsafe WAV: {path}")
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            if digest in training_hashes:
                raise ValueError(f"Test WAV identical to original training: {path.name}")
            if digest in seen:
                raise ValueError(f"Duplicate WAV within test set: {path.name}")
            seen.add(digest)
            rows.append((label, path, digest))
    signature = hashlib.sha256("\n".join(
        f"{label}/{path.name} {digest}" for label, path, digest in rows
    ).encode("utf-8")).hexdigest()
    return rows, signature


def read_capture_pcm16(path: Path) -> tuple[np.ndarray, dict]:
    """Strictly decode the original CCTV mono 16 kHz PCM16 WAV; no crop."""
    try:
        with wave.open(str(path), "rb") as wav:
            channels, width, rate = wav.getnchannels(), wav.getsampwidth(), wav.getframerate()
            compression, frames = wav.getcomptype(), wav.getnframes()
            if (channels, width, rate, compression) != (1, 2, SAMPLE_RATE, "NONE"):
                raise ValueError(f"Expected uncompressed 16 kHz mono PCM16: {path.name}")
            if not 0.3 <= frames / rate <= 2.5:
                raise ValueError(f"Unexpected audio duration in {path.name}: {frames/rate:.3f}s")
            pcm = wav.readframes(frames)
    except (wave.Error, EOFError) as exc:
        raise ValueError(f"Bad WAV structure {path.name}: {exc}") from exc
    if len(pcm) != frames * 2:
        raise ValueError(f"Truncated WAV: {path.name}")
    audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
    if not len(audio) or not np.isfinite(audio).all():
        raise ValueError(f"Invalid PCM in {path.name}")
    abs_audio = np.abs(audio)
    rms = float(np.sqrt(np.mean(audio * audio)))
    peak = float(abs_audio.max())
    if rms < 0.002:
        raise ValueError(f"Nearly silent WAV: {path.name}")
    edge = min(len(audio) // 4, round(SAMPLE_RATE * 0.2))
    def rms_db(x):
        return round(20 * math.log10(max(float(np.sqrt(np.mean(x*x))), 1e-8)), 2)
    properties = {
        "duration_seconds": round(len(audio) / SAMPLE_RATE, 4),
        "rms_dbfs": rms_db(audio),
        "peak_dbfs": round(20 * math.log10(max(peak, 1e-8)), 2),
        "fraction_near_clipping": round(float(np.mean(abs_audio >= 0.99)), 5),
        "first_200ms_rms_dbfs": rms_db(audio[:edge]),
        "last_200ms_rms_dbfs": rms_db(audio[-edge:]),
    }
    return audio, properties


def transcribe_one(model, audio: np.ndarray) -> tuple[str, list[dict]]:
    """Deterministic, unconstrained English ASR without vocabulary prompting."""
    segments, _ = model.transcribe(
        audio,
        language="en",
        task="transcribe",
        beam_size=5,
        temperature=0.0,
        vad_filter=False,
        condition_on_previous_text=False,
        initial_prompt=None,
    )
    entries = [
        {"start": round(float(s.start), 3),
         "end": round(float(s.end), 3), "text": str(s.text)}
        for s in segments
    ]
    return " ".join(item["text"].strip() for item in entries).strip(), entries


def benchmark(root: Path, test_root: Path, manifest: Path, *,
              model, model_identity: str = MODEL_ID) -> dict:
    files, signature = check_dataset(root, test_root, manifest)
    results = []
    for index, (label, path, digest) in enumerate(files, 1):
        audio, audio_stats = read_capture_pcm16(path)
        transcript, segments = transcribe_one(model, audio)
        events = keyword_events(transcript)
        results.append({
            "file": f"train/{label}/{path.name}",
            "sha256": digest,
            "expected": label,
            "transcript": transcript,
            "segments": segments,
            "keyword_events": events,
            "audio": audio_stats,
        })
        print(
            f"[V6 Whisper ASR] {index}/{len(files)} "
            f"{label.upper()} -> {','.join(events) or 'unknown'} "
            f"(audio RMS={audio_stats['rms_dbfs']:.1f}dBFS)",
            flush=True,
        )
    metrics = score_transcripts(results)
    metrics.update({
        "status": "exploratory_whisper_asr_benchmark",
        "model_id": model_identity,
        "compute_device": "cpu",
        "compute_precision": "int8",
        "fixed_beam_size": 5,
        "fixed_language": "en",
        "word_match": "strict_exact_tokens_no_approximation",
        "audio_preprocessing": "full_original_pcm16_no_cropping",
        "test_directory": str(test_root.resolve()),
        "test_fingerprint_sha256": signature,
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "test_wavs": len(files),
        "retraining_performed": False,
        "threshold_tuning_performed": False,
        "active_msds_modified": False,
        "alert_routing_modified": False,
        "legacy_holdout_used": False,
        "speaker_independence": "not_programmatically_verified",
        "labels_manually_verified": "not_programmatically_verified",
        "warning": (
            "This same 55-WAV corpus was examined during V4.1 and V5 work, "
            "so this remains exploratory and is NOT a sealed final test. "
            "Short-audio ASR can hallucinate or miss speech. Do not "
            "select a production model based on this benchmark. "
            "Predeclare criteria and test a NEW multi-speaker dataset "
            "plus continuous speech/noise before any emergency alert use."
        ),
    })
    return metrics


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Frozen, OFFLINE pretrained Whisper English CPU ASR research baseline"
    )
    parser.add_argument("--test-data", type=Path, required=True)
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--check", action="store_true",
                        help="Check all WAV formats and hashes, no ASR import/model download")
    parser.add_argument("--allow-download", action="store_true",
                        help="Explicitly permit downloading the official pretrained base.en model")
    args = parser.parse_args()
    root = args.data.resolve()
    test = args.test_data.resolve()
    manifest = (args.manifest or root / "group_manifest_v3.csv").resolve()
    try:
        files, sig = check_dataset(root, test, manifest)
        audio_stats = []
        for label, path, _ in files:
            _, stats = read_capture_pcm16(path)
            audio_stats.append({"label": label, "file": path.name, **stats})
        if args.check:
            print(json.dumps({
                "status": "v6_dataset_ready",
                "wave_files": len(files),
                "label_counts": {label: sum(x[0] == label for x in files)
                                 for label in LABELS},
                "audio_rms_dbfs_min": min(x["rms_dbfs"] for x in audio_stats),
                "audio_rms_dbfs_max": max(x["rms_dbfs"] for x in audio_stats),
                "near_clipped_files": sum(
                    x["fraction_near_clipping"] > 0.01 for x in audio_stats
                ),
                "test_fingerprint_sha256": sig,
                "model_downloaded": False,
                "model_evaluated": False,
                "alert_routing_modified": False,
                "warning": "Audio stats are not proof that a label or speaker is correct.",
            }, indent=2))
            return 0
        out = root / "artifacts" / REPORT_NAME
        if out.exists():
            raise ValueError(
                f"Existing V6 report cannot be overwritten: {out}"
            )
        try:
            from faster_whisper import WhisperModel
        except ImportError as exc:
            raise RuntimeError(
                "faster-whisper is not installed in the isolated V6 environment. "
                "Run local-server/setup_whisper_kws_v6.cmd first."
            ) from exc
        model = WhisperModel(
            MODEL_ID, device="cpu", compute_type="int8",
            cpu_threads=4, num_workers=1,
            download_root=str(DEFAULT_MODEL_CACHE),
            local_files_only=not args.allow_download,
        )
        report = benchmark(root, test, manifest, model=model)
        out.parent.mkdir(parents=True, exist_ok=True)
        with out.open("x", encoding="utf-8") as handle:
            json.dump(report, handle, indent=2, ensure_ascii=False)
        print(json.dumps({
            "status": report["status"],
            "model_id": report["model_id"],
            "correctly_accepted_positive_wavs": report["correctly_accepted_positive_wavs"],
            "positive_wavs": report["positive_wavs"],
            "accepted_positive_recall": report["accepted_positive_recall"],
            "unknown_false_positive_count": report["unknown_false_positive_count"],
            "unknown_wavs": report["unknown_wavs"],
            "per_label": report["per_label"],
            "report_path": str(out),
            "warning": report["warning"],
        }, indent=2))
        return 0
    except (ValueError, OSError, RuntimeError, ImportError) as exc:
        print(f"[V6 Whisper ASR] Aborted: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
