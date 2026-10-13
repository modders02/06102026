"""CI smoke test: launch the current MediaMTX binary with our shipped YAML.

Unlike mocked manager tests, this catches removed/renamed MediaMTX options.
Run from local-server: python smoke_mediamtx.py
Downloads MediaMTX only when missing, not the larger FFmpeg archives.
"""
from __future__ import annotations

import socket
import subprocess
import tempfile
import time
from pathlib import Path

from fetch_binaries import fetch_mediamtx

HERE = Path(__file__).resolve().parent
EXE = HERE / "bin" / "mediamtx"
CONFIG = HERE / "mediamtx.yml"
PORTS = (8554, 8888, 8889)


def is_listening(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
            return True
    except OSError:
        return False


def main() -> int:
    EXE.parent.mkdir(exist_ok=True)
    if not EXE.is_file():
        fetch_mediamtx()
    if not EXE.is_file():
        raise RuntimeError("MediaMTX executable missing after download")
    with tempfile.TemporaryFile(mode="w+b") as output:
        proc = subprocess.Popen([str(EXE), str(CONFIG)],
                                cwd=str(EXE.parent), stdout=output,
                                stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if proc.poll() is not None:
                    output.seek(0)
                    raise RuntimeError(
                        f"MediaMTX exited {proc.returncode}: " +
                        output.read().decode("utf-8", errors="replace")[-2500:]
                    )
                if all(is_listening(p) for p in PORTS):
                    print(f"MediaMTX startup smoke passed (ports {PORTS})")
                    return 0
                time.sleep(0.25)
            output.seek(0)
            raise RuntimeError("MediaMTX did not expose required ports: " +
                               output.read().decode("utf-8", errors="replace")[-2500:])
        finally:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=5)


if __name__ == "__main__":
    raise SystemExit(main())
