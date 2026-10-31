"""OFFLINE V5 benchmark using the EXISTING pretrained English sherpa Zipformer.

Unlike V3/V4/V4.1, this is NOT a train-from-scratch classifier. It reuses
the seven already-prepared English keywords and the exact pretrained KWS
configuration from neural_kws_trial.create_spotter. It NEVER attaches to a
camera, enrolls a DTW template, sends an alert, loads legacy holdout WAVs,
trains/reselects a checkpoint, or tunes thresholds against recordings.

This evaluation set has already been queried using V4.1 and can therefore
be used only as an EXPLORATORY benchmark, not a fresh sealed test of V5.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys

import numpy as np

from evaluate_noise_kws_v41 import resolve_test_root
from neural_kws_trial import create_spotter, normalize_word
from noise_kws_v3_groups import load_group_manifest
from prepare_neural_kws import MODEL_NAME, ROOT, expected_model_files
from train_noise_augmented_kws import LABELS, SAMPLE_RATE, read_audio, wavs
from train_noise_kws_v3 import DEFAULT_DATA, get_feature_engine

MODEL_ROOT = ROOT / "neural-kws-models"
DEFAULT_TEST_NAME = "sherpa_zipformer_v5.offline-benchmark.json"
TAIL_SECONDS = 0.8  # official Sherpa example applies 0.66-0.80 s tail padding
MAX_DECODE_STEPS = 4096


def model_inventory(model_root: Path) -> dict:
    """Read-only check of the exact pretrained weights and keyword file."""
    folder = model_root / MODEL_NAME
    required = (*expected_model_files(folder), model_root / "msds_keywords.txt")
    absent = [str(p) for p in required if not p.is_file() or p.stat().st_size < 1]
    if absent:
        raise FileNotFoundError(
            "Missing pretrained sherpa model or prepared keyword file. "
            "Run local-server/setup_neural_kws_windows.cmd in a separate "
            "terminal ONLY if model installation is intended. Missing: "
            + ", ".join(absent)
        )
    keyword_file = model_root / "msds_keywords.txt"
    keywords = keyword_file.read_text(encoding="utf-8-sig").splitlines()
    # Ensure all seven labels are present exactly once in the frozen file;
    # unknown is handled by the absence of detected KWS events.
    expected = set(LABELS) - {"unknown"}
    labels = []
    for line in keywords:
        if not line.strip():
            continue
        tags = [p[1:] for p in line.split() if p.startswith("@")]
        if len(tags) != 1:
            raise ValueError("Malformed existing sherpa keyword tag")
        labels.append(tags[0])
    if set(labels) != expected or len(labels) != len(expected):
        raise ValueError(
            "Prepared sherpa keyword file does not contain exactly seven "
            "unique MSDS English keyword tags. Do not silently change labels."
        )
    return {
        "name": MODEL_NAME,
        "source": "existing pretrained English sherpa-onnx KWS Zipformer",
        "relative_model_directory": MODEL_NAME,
        "keyword_file_sha256": hashlib.sha256(
            keyword_file.read_bytes()
        ).hexdigest(),
        "keyword_labels": list(labels),
        "preexisting_config": {
            "keyword_score": 1.0,
            "keyword_threshold": 0.50,
            "num_trailing_blanks": 2,
            "provider": "cpu",
            "sample_rate_hz": SAMPLE_RATE,
        },
    }


def spot_complete_clip(
    kws, samples: np.ndarray, *, tail_seconds: float = TAIL_SECONDS
) -> dict:
    """Stream full audio and fixed tail padding through a NEW sherpa KWS stream.

    Event order is preserved. Class-label information never influences
    decoding. Keyword aliases are restricted to the seven supported labels.
    A separate spotter stream prevents predictions leaking across WAVs.
    """
    audio = np.asarray(samples, dtype=np.float32)
    if audio.ndim != 1 or not len(audio) or not np.isfinite(audio).all():
        raise ValueError("Expected finite nonempty mono waveform")
    if not 0.1 <= tail_seconds <= 1.0:
        raise ValueError("Invalid fixed tail padding")
    stream = kws.create_stream()
    stream.accept_waveform(SAMPLE_RATE, audio)
    stream.accept_waveform(
        SAMPLE_RATE, np.zeros(round(SAMPLE_RATE * tail_seconds), np.float32)
    )
    stream.input_finished()
    events, ignored_raw_results, decodes = [], 0, 0
    while kws.is_ready(stream):
        if decodes >= MAX_DECODE_STEPS:
            raise RuntimeError("Sherpa failed to drain a finite audio clip")
        kws.decode_stream(stream)
        decodes += 1
        raw = kws.get_result(stream)
        if raw:
            normalized = normalize_word(raw)
            if normalized in LABELS and normalized != "unknown":
                events.append(normalized)
            else:
                ignored_raw_results += 1
            kws.reset_stream(stream)
    return {
        "events": events,
        "ignored_raw_results": ignored_raw_results,
        "decode_steps": decodes,
    }


def score_events(rows: list[dict]) -> dict:
    """A positive is correct only when all accepted events match its label.

    For UNKNOWN, ANY detected emergency word is one false-positive recording.
    We do not pick the best keyword after consulting the expected label.
    """
    by_label = {}
    positives = []
    unknown = []
    full_confusion = {
        label: dict.fromkeys(LABELS, 0) for label in LABELS
    }
    for label in LABELS:
        grouped = [r for r in rows if r["expected"] == label]
        if not grouped:
            raise ValueError(f"No evaluation examples for {label}")
        for row in grouped:
            row["first_detection"] = row["events"][0] if row["events"] else "unknown"
            row["correct_accepted"] = (
                not row["events"] if label == "unknown"
                else bool(row["events"]) and all(x == label for x in row["events"])
            )
            full_confusion[label][row["first_detection"]] += 1
        by_label[label] = {
            "count": len(grouped),
            "accepted_correct": sum(
                bool(row["correct_accepted"]) for row in grouped
            ),
            "detected_at_least_one": sum(
                bool(row["events"]) for row in grouped
            ),
            "multiple_events": sum(
                len(row["events"]) > 1 for row in grouped
            ),
            "wrong_keyword_events": sum(
                sum(x != label for x in row["events"]) for row in grouped
            ),
        }
        (unknown if label == "unknown" else positives).extend(grouped)

    false_positive_files = sum(bool(row["events"]) for row in unknown)
    correct_positives = sum(bool(row["correct_accepted"]) for row in positives)
    return {
        "positive_wavs": len(positives),
        "unknown_wavs": len(unknown),
        "correctly_accepted_positive_wavs": correct_positives,
        "accepted_positive_recall": round(correct_positives / len(positives), 4),
        "positive_detected_any_fraction": round(
            sum(bool(r["events"]) for r in positives) / len(positives), 4
        ),
        "unknown_false_positive_count": false_positive_files,
        "unknown_false_positive_fraction": round(
            false_positive_files / len(unknown), 4
        ),
        "all_keyword_event_count": sum(len(r["events"]) for r in rows),
        "multiple_detection_wavs": sum(len(r["events"]) > 1 for r in rows),
        "per_label": by_label,
        "first_detection_confusion": full_confusion,
        "per_file": rows,
    }


def verify_test_wavs(
    data_root: Path, manifest: Path, test_root: Path
) -> tuple[list[tuple[str, Path, str]], str]:
    """Reject training WAV duplicates, duplicate test WAVs and unsafe paths."""
    test_root = resolve_test_root(data_root, test_root)
    old = load_group_manifest(data_root, manifest)
    training_digests = {item["sha256"] for item in old}
    seen = set()
    rows = []
    for label in LABELS:
        folder = test_root / "train" / label
        if not folder.is_dir() or folder.is_symlink():
            raise ValueError(f"Missing or unsafe test folder: {folder}")
        paths = wavs(folder)
        if not paths:
            raise ValueError(f"No test WAVs found in {folder}")
        for path in paths:
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            if digest in training_digests:
                raise ValueError(f"Evaluation WAV duplicates training data: {path.name}")
            if digest in seen:
                raise ValueError(f"Duplicate audio across evaluation WAVs: {path.name}")
            seen.add(digest)
            rows.append((label, path, digest))
    fingerprint = hashlib.sha256(
        "\n".join(
            f"{label}/{path.name} {digest}"
            for label, path, digest in rows
        ).encode("utf-8")
    ).hexdigest()
    return rows, fingerprint


def benchmark(
    data_root: Path,
    manifest: Path,
    test_root: Path,
    model_root: Path,
    *,
    spotter_factory=create_spotter,
    extractor_factory=get_feature_engine,
) -> dict:
    inventory = model_inventory(model_root)
    rows, fingerprint = verify_test_wavs(data_root, manifest, test_root)
    spotter = spotter_factory(model_root)
    extractor = extractor_factory(data_root)
    decisions = []
    for i, (label, path, digest) in enumerate(rows, 1):
        samples = read_audio(path, extractor)
        observations = spot_complete_clip(spotter, samples)
        decisions.append({
            "file": f"train/{label}/{path.name}",
            "sha256": digest,
            "expected": label,
            "duration_s": round(len(samples) / SAMPLE_RATE, 4),
            **observations,
        })
        print(
            f"[V5 pretrained benchmark] {i}/{len(rows)} "
            f"{label.upper()} -> "
            f"{','.join(observations['events']) or 'unknown'}",
            flush=True,
        )

    result = score_events(decisions)
    result.update({
        "model": inventory,
        "test_source": str(test_root.resolve()),
        "test_fingerprint_sha256": fingerprint,
        "run_utc": datetime.now(timezone.utc).isoformat(),
        "test_wavs": len(rows),
        "retrained": False,
        "threshold_tuned": False,
        "cctv_read": False,
        "legacy_holdout_used": False,
        "live_kws_modified": False,
        "alert_routing_modified": False,
        "manual_label_verification": "not_programmatically_verified",
        "speaker_independence": "not_programmatically_verified",
        "benchmark_status": "exploratory_pretrained_kws",
        "warning": (
            "The same 55 WAVs have already been examined with V4.1. "
            "This pretrained Sherpa baseline is an EXPLORATORY comparison, "
            "NOT an independent final model-selection test. Neither a clean "
            "speaker split nor verified labels can be inferred from WAV paths. "
            "Pretrained model thresholds are unchanged. Do not deploy from "
            "these numbers or claim continuous-alert false alarm rates from "
            "20 UNKNOWN clips."
        ),
    })
    return result


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Benchmark existing pretrained Sherpa KWS offline; no alerts"
    )
    parser.add_argument("--test-data", type=Path, required=True)
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--model-root", type=Path, default=MODEL_ROOT)
    parser.add_argument("--check", action="store_true",
                        help="Check model and WAVs; do not decode or write anything")
    args = parser.parse_args()
    root = args.data.resolve()
    manifest = (args.manifest or root / "group_manifest_v3.csv").resolve()
    test_root = args.test_data.resolve()
    model_root = args.model_root.resolve()
    try:
        inventory = model_inventory(model_root)
        files, signature = verify_test_wavs(root, manifest, test_root)
        if args.check:
            print(json.dumps({
                "status": "pretrained_sherpa_ready",
                "model": inventory,
                "test_wavs": len(files),
                "fingerprint_sha256": signature,
                "operational_alerts_unchanged": True,
                "note": "File hashes and model verified; audio labels and speaker independence NOT verified",
            }, indent=2))
            return 0
        out = root / "artifacts" / DEFAULT_TEST_NAME
        if out.exists():
            raise ValueError(
                f"{out} already exists. Preserve this evaluation evidence. "
                "Use a fresh evaluation root/report name for another run."
            )
        report = benchmark(root, manifest, test_root, model_root)
        out.parent.mkdir(parents=True, exist_ok=True)
        # Exclusive creation prevents silent overwrite of previous results.
        with out.open("x", encoding="utf-8") as handle:
            json.dump(report, handle, indent=2)
        print(json.dumps({
            "status": "pretrained_sherpa_exploratory_benchmark_completed",
            "model": report["model"]["name"],
            "positive_wavs": report["positive_wavs"],
            "correctly_accepted_positive_wavs": report[
                "correctly_accepted_positive_wavs"
            ],
            "accepted_positive_recall": report["accepted_positive_recall"],
            "unknown_false_positive_count": report["unknown_false_positive_count"],
            "unknown_wavs": report["unknown_wavs"],
            "per_label": report["per_label"],
            "report_path": str(out),
            "warning": report["warning"],
        }, indent=2))
        return 0
    except (FileNotFoundError, OSError, ValueError, RuntimeError, ImportError) as exc:
        print(f"[V5 pretrained benchmark] Aborted: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
