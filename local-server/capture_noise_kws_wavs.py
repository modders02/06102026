"""Explicitly capture consented CCTV WAV training takes from the local MSDS PCM tap.

All recordings remain in ignored local-server/neural-kws-data. This utility
does NOT use the existing manual KWS enrollment endpoint or change templates.
Do not capture identifiable voice without the speaker's informed consent.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import sys
import time
import uuid
import wave
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from neural_kws_trial import (
    CHUNK_BYTES, DEFAULT_MSDS_PORT, make_bridge_request,
    pcm_bridge_enabled, read_status, validate_camera,
)
from prepare_neural_kws import KEYWORDS, ROOT

SAMPLE_RATE = 16_000
DEFAULT_DATA = ROOT / "neural-kws-data"
LABELS = (*KEYWORDS, "unknown", "noise")


def destination(root: Path, label: str, split: str) -> Path:
    if label not in LABELS or split not in ("train", "holdout"):
        raise ValueError("Invalid label or data split")
    return root / "noise" if label == "noise" else root / split / label


def make_capture_filename() -> str:
    return (datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            + "-" + uuid.uuid4().hex[:12] + ".wav")


def capture_wav(response, destination_path: Path, seconds: float) -> tuple[int, str]:
    """Read a bounded number of PCM16 bytes; save only a complete recording."""
    target = int(SAMPLE_RATE * seconds) * 2
    if target <= 0 or target > 30 * SAMPLE_RATE * 2:
        raise ValueError("Duration out of range")
    pcm = bytearray()
    while len(pcm) < target:
        block = response.read(min(CHUNK_BYTES, target - len(pcm)))
        if not block:
            raise RuntimeError("PCM stream ended before recording completed")
        pcm.extend(block)
    if len(pcm) % 2:
        raise RuntimeError("Invalid PCM sample alignment")
    # Explicit user capture: no temporary WAVs are written on failed reads.
    import numpy as np
    values = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
    rms = float(np.sqrt(np.mean(values * values)))
    if rms < 0.002:
        raise ValueError("Recording is nearly silent. Check microphone and try again.")
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    with destination_path.open("xb") as handle:
        with wave.open(handle, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(SAMPLE_RATE)
            wav.writeframes(bytes(pcm))
    return len(pcm), hashlib.sha256(pcm).hexdigest()


def capture_one_take(base: str, camera_id: str, folder: Path, seconds: float,
                     opener=urlopen, sleep=time.sleep) -> tuple[Path, int, str]:
    """Read an atomic 1-shot PCM take; retry only conflicts BEFORE recording.

    The server owns and releases the subscription within a single request.
    Never stitch pieces of interrupted recordings together or automatically
    accept silence after a failed speech take.
    """
    base_request = make_bridge_request(base, camera_id)
    request = Request(
        base_request.full_url + f"/take?seconds={seconds:g}",
        headers={
            "X-MSDS-Shadow-Client": "neural-kws-trial",
            "Accept": "application/octet-stream",
        },
    )
    expected = int(SAMPLE_RATE * seconds) * 2
    for attempt in range(6):
        try:
            # The server captures the full take BEFORE sending a response.
            # This avoids racing FastAPI StreamingResponse cleanup and lease
            # release between two successive prompts.
            print(f"[Noise capture] RECORDING NOW for {seconds:.1f} seconds...", flush=True)
            with opener(request, timeout=max(12, seconds + 8)) as response:
                if response.headers.get("X-MSDS-PCM-Format") != "s16le-16000-mono" \
                        or response.headers.get("X-MSDS-Capture") != "complete":
                    raise RuntimeError(
                        "Backend does not support atomic PCM takes. Pull the "
                        "branch and FULLY restart the local camera bridge."
                    )
                pcm = response.read(expected + 1)
            if len(pcm) != expected:
                raise RuntimeError(
                    f"Incomplete PCM response: {len(pcm)} of {expected} bytes; "
                    "no WAV saved"
                )
            path = folder / make_capture_filename()
            count, digest = capture_wav(io.BytesIO(pcm), path, seconds)
            return path, count, digest
        except HTTPError as exc:
            if exc.code != 409 or attempt == 5:
                raise
            wait = min(0.5 * (attempt + 1), 2.0)
            print(
                f"[Noise capture] Audio tap busy BEFORE capture; "
                f"retrying in {wait:.1f}s ({attempt + 1}/5).",
                flush=True,
            )
            sleep(wait)
    raise RuntimeError("Unable to acquire PCM subscription")


def main() -> int:
    parser = argparse.ArgumentParser(description="Capture labeled CCTV WAVs without touching trained templates.")
    parser.add_argument("--label", required=True, choices=LABELS)
    parser.add_argument("--split", choices=("train", "holdout"), default="train")
    parser.add_argument("--camera", default="slot-1")
    parser.add_argument("--samples", type=int, default=1)
    parser.add_argument("--seconds", type=float, default=1.8)
    parser.add_argument("--msds-port", type=int, default=DEFAULT_MSDS_PORT)
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA)
    args = parser.parse_args()
    if not 1 <= args.samples <= 100:
        parser.error("--samples must be between 1 and 100")
    if not 0.5 <= args.seconds <= 30:
        parser.error("--seconds must be 0.5-30")
    if args.label != "noise" and not 0.5 <= args.seconds <= 2.5:
        parser.error("Keyword/unknown speech clips must be 0.5-2.5 seconds")
    if args.label == "noise" and args.split != "train":
        parser.error("Background noise sources are training-only; use --split train.")
    if not 1 <= args.msds_port <= 65535:
        parser.error("Invalid MSDS bridge port")

    base = f"http://127.0.0.1:{args.msds_port}"
    try:
        status = read_status(base)
        validate_camera(status, args.camera)
        if not pcm_bridge_enabled(status, args.camera):
            raise RuntimeError(
                "PCM feed not enabled. Restart local MSDS backend with "
                "$env:MSDS_KWS_SHADOW_PCM='1'; npm.cmd run electron:dev"
            )
    except (OSError, URLError, ValueError, RuntimeError) as exc:
        print(f"[Noise capture] Cannot connect to CCTV audio: {exc}", file=sys.stderr)
        return 2

    folder = destination(args.data.resolve(), args.label, args.split)
    print(f"[Noise capture] Label: {args.label}; split: {args.split}; samples: {args.samples}")
    print(f"[Noise capture] Save private files to: {folder}")
    print("[Noise capture] Consent is required. No external upload, template changes or alerts.")
    print("[Noise capture] Keep the neural shadow LISTENER STOPPED while recording: one tap subscriber per camera.")
    if args.label == "unknown":
        print("[Noise capture] Speak natural non-keyword phrases; never say the seven emergency keywords.")
    if args.label == "noise":
        print("[Noise capture] Record real fan, air-conditioner or traffic noise WITHOUT keyword speech.")
    saved = 0
    try:
        while saved < args.samples:
            answer = input(
                f"[Noise capture] Press ENTER for take {saved + 1}/{args.samples}; "
                "q then ENTER to stop: "
            )
            if answer.strip().lower() == "q":
                print("[Noise capture] Stopped without further recordings.")
                break
            try:
                path, byte_count, digest = capture_one_take(
                    base, args.camera, folder, args.seconds
                )
                saved += 1
                print(
                    f"[Noise capture] Saved: {path.name}, "
                    f"bytes={byte_count}, sha256={digest[:12]}", flush=True,
                )
            except HTTPError as exc:
                if exc.code == 503:
                    print(
                        "[Noise capture] Microphone PCM interrupted (HTTP 503). "
                        "No WAV saved. Check camera audio, then press ENTER to "
                        "repeat this SAME take; q to stop.", file=sys.stderr,
                    )
                    continue
                if exc.code == 404:
                    print(
                        "[Noise capture] Atomic take endpoint is missing. Pull "
                        "the branch and fully restart the MSDS backend.",
                        file=sys.stderr,
                    )
                else:
                    print(
                        f"[Noise capture] HTTP {exc.code}. Close any separate "
                        "neural shadow listener and verify the backend.",
                        file=sys.stderr,
                    )
                return 3
            except (OSError, URLError, RuntimeError, ValueError) as exc:
                print(
                    f"[Noise capture] Incomplete or invalid take: {exc}. "
                    "No WAV saved; press ENTER to record the SAME take again.",
                    file=sys.stderr,
                )
    except (KeyboardInterrupt, EOFError):
        print("\n[Noise capture] Stopped by user.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
