"""MSDS local camera bridge — entry point.

The implementation now lives in the `msds/` package:

    msds/config.py          ports, limits, distress keywords
    msds/binaries.py        ffmpeg / ffprobe / mediamtx discovery (cached)
    msds/kws_engine.py      trained custom keyword recognizer
    msds/camera.py          one independent pipeline per camera
    msds/manager.py         registry, MediaMTX supervision, watchdog
    msds/api.py             FastAPI routes (unchanged contract)

Run:  python camera_server.py     (or start_server.bat on Windows)
"""
from __future__ import annotations

import os
import signal
import sys
import threading

# GPU use is mandatory on this dedicated experimental branch, even when
# camera_server.py is started directly rather than via PowerShell.
os.environ["MSDS_REQUIRE_CUDA"] = "1"
from msds.neural_kws_trial import require_cuda
try:
    _gpu_name = require_cuda()
except Exception as exc:
    raise SystemExit(
        f"[MSDS GPU REQUIRED] {exc}. No CPU inference fallback is permitted."
    ) from exc

import uvicorn

from msds.api import app
from msds.binaries import binary_report, install_hint
from msds.config import API_PORT, HLS_PORT
from msds.manager import start_mediamtx, stop_all_cameras, stop_mediamtx, watchdog
from msds.service_recovery import api_port_in_use


def shutdown(*_args):
    stop_all_cameras()
    stop_mediamtx()
    raise SystemExit(0)


def main() -> None:
    # Do not start a second MediaMTX if the API port already belongs to
    # another running MSDS instance (Electron reuses an existing bridge).
    # Deliberately never kill a healthy/unknown API listener automatically.
    if api_port_in_use(API_PORT):
        print(
            f"[MSDS startup] API port {API_PORT} is already in use. "
            "The previous camera service may already be running. "
            "Close that instance before starting another. "
            "MediaMTX and camera processes have not been started.",
            file=sys.stderr, flush=True,
        )
        raise SystemExit(2)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    for name, env_var, path in binary_report():
        print(f"{name:9s}: {path or 'NOT FOUND -> ' + install_hint(name, env_var)}", flush=True)

    threading.Thread(target=watchdog, daemon=True).start()
    start_mediamtx()

    print(f"MSDSystem multi-camera bridge on http://0.0.0.0:{API_PORT} (HLS :{HLS_PORT})")
    print(f"python   : {sys.executable}")
    from msds import kws_verifier
    if kws_verifier.enabled():
        print(
            f"audio    : custom KWS + ASR verification trial "
            f"(Whisper model: {kws_verifier.model_name()}; downloads on first use)",
            flush=True,
        )
    else:
        print("audio    : trained custom KWS only (ASR verifier off)", flush=True)

    uvicorn.run(app, host="0.0.0.0", port=API_PORT, log_level="warning")


if __name__ == "__main__":
    main()
