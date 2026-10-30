"""Optional READ-ONLY neural KWS comparison on an existing local MSDS CCTV stream.

This program is an isolated shadow observer. It never calls the enrollment
API, changes old DTW templates, or sends words into the Camera Alert path.
It reads the local MediaMTX RTSP relay, which avoids exposing CCTV passwords.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
from urllib.error import URLError
from urllib.request import urlopen

from prepare_neural_kws import KEYWORDS, MODEL_NAME, ROOT, expected_model_files

SAMPLE_RATE = 16_000
CHUNK_SAMPLES = 3_200
CHUNK_BYTES = CHUNK_SAMPLES * 2
DEFAULT_MSDS_PORT = 5000
DEFAULT_RTSP_PORT = 8554
CAMERA_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{1,60}$")
KEYWORD_SET = frozenset(KEYWORDS)
DETECTION_COOLDOWN_S = 3.0


def normalize_word(raw: str | None) -> str | None:
    if not isinstance(raw, str):
        return None
    word = re.sub(r"[^a-z]+", " ", raw.lower()).strip()
    return word if word in KEYWORD_SET else None


def validate_camera(status: dict, camera_id: str) -> str:
    """Read a camera relay path from /status; never accept an arbitrary RTSP URL."""
    if not CAMERA_ID_RE.fullmatch(camera_id):
        raise ValueError("Invalid camera ID")
    for camera in status.get("cameras", []):
        if camera.get("id") != camera_id:
            continue
        audio = camera.get("audio") or {}
        path = camera.get("path", "")
        if not CAMERA_ID_RE.fullmatch(str(path)):
            raise ValueError("Unsafe or missing relay path")
        if not camera.get("enabled") or not camera.get("ffmpeg"):
            raise RuntimeError(f"{camera_id} is not streaming video yet. Connect it in MSDS.")
        if not audio.get("connected") or not audio.get("thread_running"):
            raise RuntimeError(f"{camera_id} has no active CCTV audio. Check /status audio first.")
        return str(path)
    raise RuntimeError(f"Camera {camera_id!r} is not configured in the running MSDS bridge")


def read_status(base: str, timeout: float = 4) -> dict:
    with urlopen(f"{base}/status", timeout=timeout) as response:
        status = json.load(response)
    if not isinstance(status, dict):
        raise RuntimeError("Unexpected /status response")
    return status


def dtw_snapshot(status: dict, camera_id: str) -> dict:
    """Diagnostic state, NOT a synchronized segment-to-segment comparison."""
    for camera in status.get("cameras", []):
        if camera.get("id") == camera_id:
            kws = ((camera.get("audio") or {}).get("custom_kws") or {})
            return {
                "candidate": kws.get("last_candidate"),
                "decision": kws.get("last_decision"),
                "confidence": kws.get("last_candidate_confidence"),
                "segment_at": kws.get("last_segment_at"),
                "last_accepted": kws.get("last_keyword"),
                "last_accepted_at": kws.get("last_detected_at"),
            }
    return {}


def create_spotter(model_root: Path):
    """Load model only in the isolated --neural KWS Python interpreter."""
    import sherpa_onnx

    model = model_root / MODEL_NAME
    files = expected_model_files(model)
    if not all(p.is_file() for p in files):
        raise FileNotFoundError(
            "English neural model missing. Run local-server/setup_neural_kws_windows.cmd"
        )
    keywords_file = model_root / "msds_keywords.txt"
    if not keywords_file.is_file():
        raise FileNotFoundError("MSDS keyword tokens are missing; rerun neural KWS setup")
    return sherpa_onnx.KeywordSpotter(
        tokens=str(model / "tokens.txt"),
        encoder=str(model / "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx"),
        decoder=str(model / "decoder-epoch-12-avg-2-chunk-16-left-64.onnx"),
        joiner=str(model / "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx"),
        keywords_file=str(keywords_file),
        num_threads=2,
        sample_rate=SAMPLE_RATE,
        feature_dim=80,
        keywords_score=1.0,
        keywords_threshold=0.50,
        num_trailing_blanks=2,
        provider="cpu",
    )


def consume_pcm_chunk(kws, stream, raw: bytes) -> tuple[object, list[str]]:
    """Stream one 200 ms packet; return a new stream when a keyword is found."""
    import numpy as np

    if len(raw) % 2:
        raise ValueError("PCM16 chunk has an odd number of bytes")
    if not raw:
        return stream, []
    samples = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    stream.accept_waveform(SAMPLE_RATE, samples)
    detected = []
    while kws.is_ready(stream):
        kws.decode_stream(stream)
        result = normalize_word(kws.get_result(stream))
        if result:
            detected.append(result)
            kws.reset_stream(stream)
    return stream, detected


def ffmpeg_executable() -> str:
    supplied = os.environ.get("FFMPEG_EXE", "").strip().strip('"')
    if supplied and Path(supplied).is_file():
        return supplied
    try:
        from msds.binaries import resolve_exe
        found = resolve_exe("ffmpeg", "FFMPEG_EXE")
        if found:
            return str(found)
    except ImportError:
        pass
    found = shutil.which("ffmpeg")
    if not found:
        raise FileNotFoundError("FFmpeg is unavailable; install MSDS camera bridge dependencies first")
    return found


def make_ffmpeg_args(executable: str, relay_path: str, rtsp_port: int) -> list[str]:
    if not CAMERA_ID_RE.fullmatch(relay_path):
        raise ValueError("Unsafe relay path")
    if not (1 <= rtsp_port <= 65535):
        raise ValueError("Invalid RTSP port")
    return [
        executable, "-nostdin", "-hide_banner", "-loglevel", "error",
        "-rtsp_transport", "tcp", "-rw_timeout", "5000000",
        "-i", f"rtsp://127.0.0.1:{rtsp_port}/{relay_path}",
        "-map", "0:a:0", "-vn",
        "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "s16le", "pipe:1",
    ]


def record_detection(file, word: str, camera_id: str, base: str, started_at: float):
    at = datetime.now(timezone.utc).isoformat()
    # Query the existing DTW diagnostics as the nearest available observation;
    # these are NOT synchronized results for the same waveform or utterance.
    try:
        old = dtw_snapshot(read_status(base, timeout=1.5), camera_id)
    except (OSError, URLError, ValueError, RuntimeError):
        old = {}
    entry = {
        "timestamp": at, "camera_id": camera_id, "neural_word": word,
        "neural_uptime_s": round(time.monotonic() - started_at, 1),
        "dtw_latest_snapshot": old, "mode": "shadow_read_only",
    }
    file.write(json.dumps(entry, ensure_ascii=True) + "\n")
    file.flush()
    print(
        f"[NEURAL SHADOW] {word.upper()} detected | DTW latest candidate: "
        f"{old.get('candidate') or 'none'} ({old.get('decision') or 'no snapshot'})",
        flush=True,
    )


def main():
    parser = argparse.ArgumentParser(description="Passive neural vs DTW CCTV keyword comparison.")
    parser.add_argument("--camera", default="slot-1")
    parser.add_argument("--msds-port", type=int, default=DEFAULT_MSDS_PORT)
    parser.add_argument("--rtsp-port", type=int, default=DEFAULT_RTSP_PORT)
    parser.add_argument("--seconds", type=int, default=0, help="Trial duration; 0 is unlimited")
    parser.add_argument("--output", type=Path, default=None, help="JSONL report (metadata only)")
    args = parser.parse_args()
    if not (1 <= args.msds_port <= 65535):
        parser.error("Invalid MSDS API port")
    if args.seconds < 0:
        parser.error("--seconds must be nonnegative")

    base = f"http://127.0.0.1:{args.msds_port}"
    try:
        status = read_status(base)
        path = validate_camera(status, args.camera)
        kws = create_spotter(ROOT / "neural-kws-models")
        ffmpeg = ffmpeg_executable()
    except Exception as exc:
        print(f"[NEURAL SHADOW] Cannot start: {exc}", file=sys.stderr)
        return 1

    output = args.output or (ROOT / "neural-kws-results" /
                             ("trial-" + datetime.now().strftime("%Y%m%d-%H%M%S") + ".jsonl"))
    output.parent.mkdir(parents=True, exist_ok=True)
    print("[NEURAL SHADOW] Using the same local MediaMTX camera relay; does not change MSDS audio or DTW templates.")
    print("[NEURAL SHADOW] Camera:", args.camera, " | Model:", MODEL_NAME)
    print("[NEURAL SHADOW] Monitoring seven English keywords, CPU mode.")
    print("[NEURAL SHADOW] Logs contain labels/DTW metadata only; no raw audio.")
    print("[NEURAL SHADOW] Output:", output)
    print("[NEURAL SHADOW] Ctrl+C stops the experiment.")
    started = time.monotonic()
    last_detection: dict[str, float] = {}
    run_until = started + args.seconds if args.seconds else float("inf")
    with output.open("a", encoding="utf-8") as log:
        while time.monotonic() < run_until:
            # Reconnect to the relay when the camera is restarted; drop neural
            # decoding state between sessions rather than carry stale context.
            try:
                status = read_status(base)
                path = validate_camera(status, args.camera)
            except (OSError, URLError, ValueError, RuntimeError) as exc:
                print(f"[NEURAL SHADOW] Waiting for CCTV audio: {exc}", flush=True)
                time.sleep(3)
                continue
            stream = kws.create_stream()
            cmd = make_ffmpeg_args(ffmpeg, path, args.rtsp_port)
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                    stdin=subprocess.DEVNULL, bufsize=0)
            try:
                print("[NEURAL SHADOW] Listening; test HELP/FIRE with fan or TV noise, then try neutral speech.", flush=True)
                while time.monotonic() < run_until:
                    assert proc.stdout is not None
                    block = proc.stdout.read(CHUNK_BYTES)
                    if not block:
                        break
                    stream, words = consume_pcm_chunk(kws, stream, block)
                    for word in words:
                        now = time.monotonic()
                        if now - last_detection.get(word, -1e10) < DETECTION_COOLDOWN_S:
                            continue
                        last_detection[word] = now
                        record_detection(log, word, args.camera, base, started)
            except KeyboardInterrupt:
                print("\n[NEURAL SHADOW] Stopped. Your active KWS is unchanged.")
                return 0
            finally:
                if proc.poll() is None:
                    proc.terminate()
                    try:
                        proc.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                if proc.stdout:
                    proc.stdout.close()
            if time.monotonic() < run_until:
                print("[NEURAL SHADOW] Local relay audio ended; retrying in 3 seconds.", flush=True)
                time.sleep(3)
    print("[NEURAL SHADOW] Trial finished.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
