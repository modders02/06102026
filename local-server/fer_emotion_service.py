"""Optional, loopback-only FER expression classifier for MSDS.

Run using a separate Python venv:
  py -3.12 -m venv local-server\.fer-venv
  local-server\.fer-venv\Scripts\python.exe -m pip install -r local-server\requirements-fer.txt
  local-server\.fer-venv\Scripts\python.exe local-server\fer_emotion_service.py

FER runs as a sidecar so TensorFlow/OpenCV dependencies never alter the stable
camera server, enrolled DTW templates, or CUDA environment. JPEGs remain in
memory and never leave the computer. This service is observational: the
browser's existing face-api model remains responsible for alert evidence.
"""
from __future__ import annotations

import json
import math
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "127.0.0.1"
PORT = int(os.environ.get("MSDS_FER_PORT", "5066"))
MAX_IMAGE_BYTES = 300_000
ALLOWED_ORIGINS = {
    "http://localhost:8080",
    "http://127.0.0.1:8080",
    "msds://app",
    "null",  # Electron custom-protocol/webview environments
}
EMOTION_KEYS = ("angry", "disgust", "fear", "happy", "sad", "surprise", "neutral")

# No per-frame model initialization and no concurrent TensorFlow inference.
fer_detector = None
cv2 = None
np = None
infer_lock = threading.Lock()


def sanitize_predictions(detections):
    """Return the largest detected face and strictly validated FER scores."""
    if not isinstance(detections, list):
        return None
    faces = [item for item in detections if isinstance(item, dict)
             and isinstance(item.get("box"), (list, tuple))
             and len(item["box"]) == 4 and isinstance(item.get("emotions"), dict)]
    if not faces:
        return None

    def area(item):
        try:
            return max(0, float(item["box"][2])) * max(0, float(item["box"][3]))
        except (ValueError, TypeError):
            return 0

    face = max(faces, key=area)
    if area(face) < 400:
        return None
    scores = {}
    for key in EMOTION_KEYS:
        value = face["emotions"].get(key, 0.0)
        # FER commonly returns numpy.float32 scores, not plain Python float.
        # Accept numeric scalar convertibles while rejecting NaN/infinity.
        if isinstance(value, (bool, str, bytes)):
            return None
        try:
            value = float(value)
        except (TypeError, ValueError, OverflowError):
            return None
        if not 0 <= value <= 1 or not math.isfinite(value):
            return None
        scores[key] = value
    label = max(scores, key=scores.get)
    return {"label": label, "confidence": round(scores[label], 5), "scores": scores}


class FerHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Do not log IPs, frames, or request bodies.
        pass

    def _origin_allowed(self):
        origin = self.headers.get("Origin")
        return origin is None or origin in ALLOWED_ORIGINS

    def _respond(self, status, payload):
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        origin = self.headers.get("Origin")
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        if not self._origin_allowed():
            return self._respond(403, {"ok": False, "error": "forbidden_origin"})
        self.send_response(204)
        origin = self.headers.get("Origin")
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Max-Age", "600")
            self.send_header("Vary", "Origin")
        self.end_headers()

    def do_GET(self):
        if not self._origin_allowed():
            return self._respond(403, {"ok": False, "error": "forbidden_origin"})
        if self.path != "/health":
            return self._respond(404, {"ok": False})
        return self._respond(200, {"ok": True, "engine": "fer", "mode": "display-only", "ready": fer_detector is not None})

    def do_POST(self):
        if not self._origin_allowed():
            return self._respond(403, {"ok": False, "error": "forbidden_origin"})
        if self.path != "/analyze":
            return self._respond(404, {"ok": False})
        if self.headers.get("Content-Type", "").split(";")[0].strip().lower() != "image/jpeg":
            return self._respond(415, {"ok": False, "error": "jpeg_required"})
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            size = 0
        if size < 100 or size > MAX_IMAGE_BYTES:
            return self._respond(413, {"ok": False, "error": "image_size_invalid"})
        raw = self.rfile.read(size)
        if len(raw) != size:
            return self._respond(400, {"ok": False, "error": "incomplete_image"})
        frame = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
        if frame is None or frame.size == 0 or max(frame.shape[:2]) > 1280:
            return self._respond(400, {"ok": False, "error": "invalid_image"})
        try:
            with infer_lock:
                # FER's documented interface accepts images loaded by cv2,
                # and performs face detection + seven-class classification.
                result = sanitize_predictions(fer_detector.detect_emotions(frame))
        except Exception:
            return self._respond(503, {"ok": False, "error": "inference_unavailable"})
        if result is None:
            return self._respond(200, {"ok": True, "has_face": False, "engine": "fer"})
        return self._respond(200, {"ok": True, "has_face": True, "engine": "fer", **result})


def main():
    global fer_detector, cv2, np
    try:
        import cv2 as cv
        import numpy as numpy
        from fer import FER
        cv2, np = cv, numpy
        fer_detector = FER(mtcnn=False)
    except Exception as exc:
        print(f"[FER] Could not initialize optional FER classifier: {exc}", flush=True)
        raise SystemExit(1) from exc
    print(f"[FER] Ready at http://{HOST}:{PORT}/health (CPU-oriented, display-only)", flush=True)
    server = ThreadingHTTPServer((HOST, PORT), FerHandler)
    try:
        server.serve_forever(poll_interval=0.3)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
