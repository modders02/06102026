"""Record labeled CCTV-microphone words locally, without touching alerts or model.

Run with the MSDS camera already connected:
  python local-server/collect_english_kws.py --camera slot-1 --keyword help --count 5
  python local-server/collect_english_kws.py --camera slot-1 --keyword unknown --count 10
  python local-server/collect_english_kws.py --camera slot-1 --keyword fire --count 2 --set holdout

The RTSP source is resolved exclusively from the local MSDS bridge; camera
credentials and recordings are never sent to GitHub or Supabase.
"""
from __future__ import annotations

import argparse
import json
import math
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
import wave
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from msds.config import RTSP_PORT  # noqa: E402
from msds.kws_engine import (  # noqa: E402
    DEFAULT_KEYWORDS, NEGATIVE_CLASS, SAMPLE_RATE, StreamingSpeechSegmenter,
)

KEYWORDS = frozenset((*DEFAULT_KEYWORDS, NEGATIVE_CLASS))
BLOCK_BYTES = 3200  # 100 ms, 16 kHz mono s16le
MAX_WAIT_SECONDS = 9
MAX_RECORD_SECONDS = 15


def camera_source(camera_id: str, host: str = "http://127.0.0.1:5000") -> tuple[str, str]:
    """Use the already-connected *local restream*; never expose RTSP passwords."""
    try:
        with urllib.request.urlopen(host + "/status", timeout=5) as response:
            status = json.load(response)
    except (OSError, ValueError) as exc:
        raise RuntimeError("Local MSDS camera bridge is not available at 127.0.0.1:5000.") from exc

    cam = next((item for item in status.get("cameras", []) if item.get("id") == camera_id), None)
    if not cam:
        ids = [item.get("id") for item in status.get("cameras", [])]
        raise RuntimeError(f"Camera {camera_id!r} is not connected. Available IDs: {ids!r}")
    if not cam.get("ffmpeg"):
        raise RuntimeError("Connect the camera in MSDS before recording CCTV audio.")
    path = cam.get("path", "")
    if not isinstance(path, str) or not path or "/" in path or not all(
        c.isascii() and (c.isalnum() or c in "-_") for c in path
    ):
        raise RuntimeError("Invalid local camera stream path.")

    candidates = [
        status.get("ffmpeg_path"),
        str(HERE / "bin" / ("ffmpeg.exe" if sys.platform == "win32" else "ffmpeg")),
        shutil.which("ffmpeg"),
    ]
    ffmpeg = next((str(candidate) for candidate in candidates if candidate and
                   (Path(str(candidate)).is_file() or shutil.which(str(candidate)))), None)
    if not ffmpeg:
        raise RuntimeError("FFmpeg is missing. Run local-server/setup_windows.bat.")
    return ffmpeg, f"rtsp://127.0.0.1:{RTSP_PORT}/{path}"


def extract_utterance(blocks: list[bytes]) -> bytes | None:
    """Reuse the live KWS segmentation algorithm for offline test fixtures."""
    segmenter = StreamingSpeechSegmenter()
    detected: list[bytes] = []
    for block in blocks:
        detected.extend(segmenter.feed(block))
    return detected[0] if len(detected) == 1 else None


def check_quality(pcm: bytes) -> None:
    seconds = len(pcm) / (SAMPLE_RATE * 2)
    if not 0.30 <= seconds <= 2.50:
        raise ValueError("Unclear utterance length; say one short word, then pause.")
    samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
    peak = float(np.max(np.abs(samples)))
    rms = float(np.sqrt(np.mean(samples * samples)))
    clipped = float(np.mean(np.abs(samples) >= 0.985))
    if rms < 0.015 or peak < 0.035:
        raise ValueError("Recording is too quiet: move closer to the camera.")
    if clipped > 0.02:
        raise ValueError("Audio is distorted: lower the camera microphone gain.")


def capture_once(ffmpeg: str, url: str, max_wait: int = MAX_WAIT_SECONDS) -> bytes:
    """Capture exactly one segment, without storing continuous surveillance audio."""
    cmd = [
        ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error",
        "-rtsp_transport", "tcp", "-timeout", "10000000",
        "-i", url, "-vn", "-sn", "-dn", "-map", "0:a:0",
        "-acodec", "pcm_s16le", "-ar", str(SAMPLE_RATE), "-ac", "1",
        "-f", "s16le", "pipe:1",
    ]
    try:
        proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL)
    except OSError as exc:
        raise RuntimeError("Could not launch the configured FFmpeg executable.") from exc
    killed = threading.Event()
    def kill_after_timeout() -> None:
        if proc.poll() is None:
            killed.set()
            proc.kill()
    watchdog = threading.Timer(MAX_RECORD_SECONDS, kill_after_timeout)
    watchdog.daemon = True
    watchdog.start()
    try:
        if proc.stdout is None:
            raise RuntimeError("FFmpeg audio pipe is unavailable.")
        # Audio streaming startup may take seconds. Wait for the first valid
        # block, then tell the speaker precisely when to say their word.
        first = proc.stdout.read(BLOCK_BYTES)
        if len(first) != BLOCK_BYTES:
            raise RuntimeError("The selected CCTV RTSP stream has no usable audio track.")
        print("\nAUDIO READY — say your selected word once, clearly, then stay silent.", flush=True)
        segmenter = StreamingSpeechSegmenter()
        ready_at = time.monotonic()
        while time.monotonic() - ready_at < max_wait:
            data = proc.stdout.read(BLOCK_BYTES)
            if len(data) != BLOCK_BYTES:
                break
            segments = segmenter.feed(data)
            if segments:
                speech = segments[0]
                check_quality(speech)
                return speech
        if killed.is_set():
            raise RuntimeError("CCTV audio stopped responding. Check camera microphone/RTSP settings.")
        raise RuntimeError("No complete spoken word detected. Retry with a quieter interval or move closer.")
    finally:
        watchdog.cancel()
        if proc.poll() is None:
            proc.kill()
        try:
            proc.communicate(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()


def write_wav(path: Path, pcm: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(SAMPLE_RATE)
        out.writeframes(pcm)


def review_and_save(destination: Path, pcm: bytes, autoplay: bool = True) -> bool:
    """Require a human to confirm the label; VAD cannot identify untrained words."""
    with tempfile.TemporaryDirectory(prefix="msds-kws-review-") as temp:
        review = Path(temp) / "review.wav"
        write_wav(review, pcm)
        if autoplay and sys.platform == "win32":
            try:
                import winsound
                print("Replaying captured speech for label verification...", flush=True)
                winsound.PlaySound(str(review), winsound.SND_FILENAME)
            except (OSError, RuntimeError):
                print("Playback unavailable; review the phrase before accepting.")
        answer = input("Was it ONE correctly spoken phrase for this label? [y/N] ").strip().lower()
        if answer not in ("y", "yes"):
            print("Discarded. No sample saved.")
            return False
        destination.mkdir(parents=True, exist_ok=True)
        index = 1 + len(list(destination.glob("*.wav")))
        filename = f"take-{index:03d}-{uuid.uuid4().hex[:8]}.wav"
        write_wav(destination / filename, pcm)
        print(f"Saved: {destination / filename}")
        return True


def main() -> int:
    parser = argparse.ArgumentParser(description="Collect English emergency KWS samples from an active CCTV camera.")
    parser.add_argument("--camera", default="slot-1", help="Local connected camera ID from /status.")
    parser.add_argument("--keyword", required=True, choices=sorted(KEYWORDS))
    parser.add_argument("--count", type=int, default=5, help="Number of new accepted recordings (not attempts).")
    parser.add_argument("--set", choices=("train", "holdout"), default="train")
    parser.add_argument("--no-playback", action="store_true", help="Skip Windows audio playback before label review.")
    args = parser.parse_args()
    if not 1 <= args.count <= 40:
        parser.error("--count must be between 1 and 40")
    try:
        ffmpeg, stream = camera_source(args.camera)
    except RuntimeError as exc:
        print(f"Camera setup: {exc}", file=sys.stderr)
        return 1
    root = HERE / ("kws-training-english" if args.set == "train" else "kws-holdout-english")
    destination = root / args.keyword
    print(f"Label: {args.keyword.upper()} | set: {args.set} | requested: {args.count}")
    print("Use authorized consenting speakers. Never record bystanders.")
    print("For UNKNOWN, speak unrelated ordinary words/phrases (not emergency keywords).")
    print("Press Enter, then wait until AUDIO READY before speaking; the microphone is the connected CCTV.")
    accepted, attempts = 0, 0
    while accepted < args.count:
        answer = input(f"\nRecording {accepted + 1}/{args.count}. Enter=start, q=quit: ").strip().lower()
        if answer == "q":
            break
        attempts += 1
        try:
            pcm = capture_once(ffmpeg, stream)
            if review_and_save(destination, pcm, autoplay=not args.no_playback):
                accepted += 1
        except (ValueError, RuntimeError) as exc:
            print(f"Not saved: {exc}")
        if attempts >= args.count * 6 and accepted < args.count:
            print("Repeated capture failures. Check live audio diagnostics before continuing.")
            break
    print(f"Finished: {accepted} accepted / {attempts} attempts. No existing KWS templates were modified.")
    return 0 if accepted == args.count else 2


if __name__ == "__main__":
    raise SystemExit(main())
