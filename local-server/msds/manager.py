"""Camera registry, MediaMTX supervision and the per-camera watchdog."""
from __future__ import annotations

import os
import re
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Dict, List, Optional

from .binaries import install_hint, no_window_flags, resolve_exe
from .camera import Camera
from .config import MAX_CAMERAS, MEDIAMTX_CONFIG
from .service_recovery import recover_media_ports

CAMERAS: Dict[str, Camera] = {}
CAM_LOCK = threading.Lock()
MEDIAMTX: Optional[subprocess.Popen] = None
_MEDIAMTX_LOCK = threading.RLock()
_MEDIAMTX_LOG: Optional[Path] = None
_MEDIAMTX_ERROR: Optional[str] = None
_MEDIAMTX_RETRY_AFTER = 0.0


def _read_mediamtx_failure() -> str:
    """Return the last useful startup lines, not a silent False status.

    MediaMTX writes Go startup and configuration failures to stdout/stderr.
    Use a log file because Windows pipes can block if not continuously drained.
    Do not expose full camera RTSP URLs in the API/status output.
    """
    try:
        if _MEDIAMTX_LOG and _MEDIAMTX_LOG.exists():
            # Startup logs are normally short; read only the last 16 KiB.
            with _MEDIAMTX_LOG.open("rb") as handle:
                handle.seek(0, os.SEEK_END)
                handle.seek(max(0, handle.tell() - 16384))
                lines = handle.read().decode("utf-8", errors="replace").splitlines()
            useful = [line.strip() for line in lines if line.strip()][-6:]
            text = " | ".join(useful)
            # Strip RTSP URL userinfo, which could contain camera passwords.
            text = re.sub(r"(rtsps?://)[^\s/@]+@", r"\1[redacted]@", text)
            if text:
                return text[-1200:]
    except OSError:
        pass
    return "No diagnostic output. Run mediamtx.exe mediamtx.yml directly for details."


def _running_unlocked() -> bool:
    global _MEDIAMTX_ERROR
    if MEDIAMTX is None:
        return False
    exit_code = MEDIAMTX.poll()
    if exit_code is None:
        return True
    if not _MEDIAMTX_ERROR:
        _MEDIAMTX_ERROR = (
            f"MediaMTX exited with code {exit_code}: {_read_mediamtx_failure()}"
        )
    return False


def mediamtx_running() -> bool:
    with _MEDIAMTX_LOCK:
        return _running_unlocked()


def mediamtx_last_error() -> Optional[str]:
    with _MEDIAMTX_LOCK:
        if _running_unlocked():
            return None
        return _MEDIAMTX_ERROR or "MediaMTX is not running."


def start_mediamtx() -> bool:
    """Start MediaMTX; detect fast failures and preserve actionable errors.

    The command may also be called from the watchdog and a camera start request.
    Serialize starts so they can never race each other and bind the same ports.
    """
    global MEDIAMTX, _MEDIAMTX_LOG, _MEDIAMTX_ERROR, _MEDIAMTX_RETRY_AFTER
    with _MEDIAMTX_LOCK:
        if _running_unlocked():
            return True

        if time.monotonic() < _MEDIAMTX_RETRY_AFTER:
            return False

        # Refresh executable resolution: users can install binaries while the
        # bridge is still running, and the earlier None result was cached.
        exe = resolve_exe("mediamtx", "MEDIAMTX_EXE", refresh=True)
        if not exe:
            _MEDIAMTX_ERROR = install_hint("mediamtx", "MEDIAMTX_EXE")
            _MEDIAMTX_RETRY_AFTER = time.monotonic() + 5
            print(f"[MediaMTX] {_MEDIAMTX_ERROR}", flush=True)
            return False

        # Reclaim orphaned MediaMTX only if both executable and YAML match
        # this installation and no live owning parent remains. Never kill a
        # stranger's port listener or an active MSDS service.
        recovery = recover_media_ports(exe, MEDIAMTX_CONFIG)
        for pid in recovery.reclaimed:
            print(f"[MediaMTX] recovered orphaned MSDS MediaMTX PID {pid}", flush=True)
        if recovery.blockers or recovery.error:
            occupied = ", ".join(recovery.blockers)
            detail = recovery.error or (
                f"MediaMTX cannot bind: {occupied}. "
                "The port owner is not a verified orphan of this MSDS install. "
                "Close the other MSDS instance or application; no process was forcibly stopped."
            )
            _MEDIAMTX_ERROR = detail
            _MEDIAMTX_RETRY_AFTER = time.monotonic() + 5
            print(f"[MediaMTX] {detail}", flush=True)
            return False

        cmd = [exe]
        if os.path.isfile(MEDIAMTX_CONFIG):
            cmd.append(MEDIAMTX_CONFIG)

        # Preserve Electron's explicit writable runtime even when it will be
        # created by its supervisor. Never redirect a packaged install into
        # the system temp directory just because the path is not visible yet.
        runtime_dir = os.environ.get("MSDS_RUNTIME_DIR") or os.path.dirname(exe)
        fd, log_name = tempfile.mkstemp(prefix="msds-mediamtx-", suffix=".log")
        new_log = Path(log_name)
        try:
            with os.fdopen(fd, "wb") as output:
                proc = subprocess.Popen(
                    cmd, stdout=output, stderr=subprocess.STDOUT,
                    cwd=runtime_dir, creationflags=no_window_flags(),
                )
        except OSError as exc:
            _MEDIAMTX_ERROR = f"Could not launch MediaMTX: {exc}"
            _MEDIAMTX_RETRY_AFTER = time.monotonic() + 5
            new_log.unlink(missing_ok=True)
            print(f"[MediaMTX] {_MEDIAMTX_ERROR}", flush=True)
            return False

        old_log = _MEDIAMTX_LOG
        MEDIAMTX = proc
        _MEDIAMTX_LOG = new_log
        _MEDIAMTX_ERROR = None
        if old_log and old_log != new_log:
            try:
                old_log.unlink(missing_ok=True)
            except OSError:
                pass

        # MediaMTX validates its YAML and binds ports very quickly. Ensure
        # a failed launch is visible instead of printing a misleading "ready".
        time.sleep(0.8)
        if not _running_unlocked():
            _MEDIAMTX_RETRY_AFTER = time.monotonic() + 5
            print(f"[MediaMTX] {_MEDIAMTX_ERROR}", flush=True)
            return False

        _MEDIAMTX_RETRY_AFTER = 0.0
        print(f"[MediaMTX] running (PID {proc.pid})", flush=True)
        return True


def stop_mediamtx() -> None:
    global MEDIAMTX
    with _MEDIAMTX_LOCK:
        if _running_unlocked() and MEDIAMTX is not None:
            MEDIAMTX.terminate()
            try:
                MEDIAMTX.wait(timeout=3)
            except subprocess.TimeoutExpired:
                MEDIAMTX.kill()
                MEDIAMTX.wait(timeout=3)
        MEDIAMTX = None


def sync_cameras(incoming: List[dict]) -> int:
    with CAM_LOCK:
        keep = set()
        for item in incoming[:MAX_CAMERAS]:
            cid = item["id"]
            keep.add(cid)
            path = re.sub(r"[^a-zA-Z0-9_-]", "-", item.get("path") or cid)
            cam = CAMERAS.get(cid)
            if cam is None:
                CAMERAS[cid] = Camera(
                    id=cid, path=path, name=item.get("name", cid),
                    rtsp=item.get("rtsp", ""), enabled=bool(item.get("enabled", True)),
                )
            else:
                changed = cam.rtsp != item.get("rtsp", "") or cam.path != path
                next_enabled = bool(item.get("enabled", True))
                cam.name = item.get("name", cam.name)
                cam.rtsp = item.get("rtsp", cam.rtsp)
                cam.path = path

                # Sync is registry reconciliation, not a global restart. If one
                # slot is explicitly disabled, stop only that camera and keep
                # every other registered camera untouched.
                if not next_enabled:
                    cam.enabled = False
                    if cam.running() or not cam.stop_flag.is_set():
                        cam.stop()
                else:
                    cam.enabled = True
                    if changed and cam.running():
                        cam.stop()
                        cam.start()
        for cid in list(CAMERAS):
            if cid not in keep:
                CAMERAS[cid].stop()
                del CAMERAS[cid]
        return len(CAMERAS)


def snapshot() -> List[Camera]:
    with CAM_LOCK:
        return list(CAMERAS.values())


def stop_all_cameras() -> None:
    for cam in snapshot():
        cam.stop()


def watchdog() -> None:
    """Keep MediaMTX and every enabled camera pipeline alive.

    MediaMTX is a long-running service and must be restarted if it exits.
    FFmpeg is intentionally per-camera and is restarted independently below.
    FFprobe is an on-demand diagnostic executable, not a background service.
    """
    while True:
        time.sleep(5)

        # MediaMTX owns the RTSP publish target and HLS server.  If it dies,
        # FFmpeg may still appear alive briefly but HLS manifests disappear,
        # producing hls.js manifestLoadError in the renderer.
        if not mediamtx_running():
            try:
                start_mediamtx()
            except Exception as exc:
                print(f"[MediaMTX watchdog] restart failed: {exc}", flush=True)

        for cam in snapshot():
            if not cam.enabled or cam.stop_flag.is_set():
                continue
            if cam.video_proc and cam.video_proc.poll() is not None:
                cam.restarts += 1
                cam.error = f"Stream disconnected: {cam.last_video_error()}. Reconnecting…"
                try:
                    time.sleep(min(5, max(1, cam.restarts)))
                    cam.start_video()
                except Exception as exc:
                    cam.error = str(exc)
            # The audio worker must stay alive for as long as the camera is on.
            if cam.video_proc and not (cam.audio_thread and cam.audio_thread.is_alive()):
                try:
                    cam.start_audio()
                except Exception as exc:
                    cam.audio_error = str(exc)

