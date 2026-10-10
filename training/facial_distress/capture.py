"""Capture labeled face crops from an MSDS camera snapshot endpoint.

Example:
  python capture.py --camera slot-1 --label normal --count 150
  python capture.py --camera slot-1 --label mild_distress --count 150
  python capture.py --camera slot-1 --label severe_distress --count 150

The script saves only the largest detected face, not the full room frame, which
reduces background leakage during training.
"""
from __future__ import annotations

import argparse
import time
import urllib.request
from pathlib import Path

import cv2
import numpy as np

LABELS = ("normal", "mild_distress", "severe_distress")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--server", default="http://127.0.0.1:5000")
    parser.add_argument("--camera", default="slot-1")
    parser.add_argument("--label", choices=LABELS, required=True)
    parser.add_argument("--count", type=int, default=150)
    parser.add_argument("--interval", type=float, default=0.35)
    parser.add_argument("--size", type=int, default=224)
    parser.add_argument("--output", default="data/raw")
    return parser.parse_args()


def fetch_jpeg(url: str) -> np.ndarray:
    with urllib.request.urlopen(url, timeout=5) as response:
        data = np.frombuffer(response.read(), dtype=np.uint8)
    frame = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if frame is None:
        raise RuntimeError("Snapshot could not be decoded.")
    return frame


def largest_face(frame: np.ndarray, detector: cv2.CascadeClassifier):
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    faces = detector.detectMultiScale(
        gray,
        scaleFactor=1.1,
        minNeighbors=5,
        minSize=(60, 60),
    )
    if len(faces) == 0:
        return None
    return max(faces, key=lambda item: item[2] * item[3])


def main() -> None:
    args = parse_args()
    if args.count < 1:
        raise SystemExit("--count must be at least 1")

    cascade = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    detector = cv2.CascadeClassifier(cascade)
    if detector.empty():
        raise RuntimeError("OpenCV face detector could not be loaded.")

    out_dir = Path(args.output) / args.label
    out_dir.mkdir(parents=True, exist_ok=True)

    existing = len(list(out_dir.glob("*.jpg")))
    endpoint = f"{args.server.rstrip('/')}/cameras/{args.camera}/snapshot"

    print(f"Collecting {args.count} '{args.label}' face samples from {endpoint}")
    print("Keep only one participant clearly visible. Vary head angle, distance, and lighting.")
    print("Press Ctrl+C to stop.")

    saved = 0
    missed = 0
    while saved < args.count:
        try:
            frame = fetch_jpeg(endpoint)
            face = largest_face(frame, detector)
            if face is None:
                missed += 1
                print(f"no face ({missed} misses)", end="\r", flush=True)
                time.sleep(args.interval)
                continue

            x, y, w, h = face
            margin = int(max(w, h) * 0.18)
            x1 = max(0, x - margin)
            y1 = max(0, y - margin)
            x2 = min(frame.shape[1], x + w + margin)
            y2 = min(frame.shape[0], y + h + margin)
            crop = frame[y1:y2, x1:x2]
            crop = cv2.resize(crop, (args.size, args.size), interpolation=cv2.INTER_AREA)

            path = out_dir / f"{args.label}_{existing + saved + 1:05d}.jpg"
            if not cv2.imwrite(str(path), crop):
                raise RuntimeError(f"Could not write {path}")

            saved += 1
            print(f"saved {saved}/{args.count}: {path.name}", end="\r", flush=True)
            time.sleep(args.interval)
        except KeyboardInterrupt:
            print("\nCapture stopped.")
            return
        except Exception as exc:
            print(f"\nCapture error: {exc}")
            time.sleep(max(args.interval, 1.0))

    print(f"\nDone. Saved {saved} samples to {out_dir}")


if __name__ == "__main__":
    main()
