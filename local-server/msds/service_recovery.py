"""Conservative recovery for orphaned MediaMTX processes from THIS MSDS install.

Never kill by process name or port alone. A process must have the exact
executable and configuration paths belonging to this installation, and its
original parent must no longer exist. Running camera bridges and unrelated
applications are left untouched. The watchdog retries once ports become free.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Iterable

import psutil

from .config import HLS_PORT, RTSP_PORT, WEBRTC_PORT

MEDIA_TCP_PORTS = frozenset((RTSP_PORT, HLS_PORT, WEBRTC_PORT, 9997))


@dataclass(frozen=True)
class PortRecovery:
    reclaimed: tuple[int, ...] = ()
    blockers: tuple[str, ...] = ()
    error: str = ""


def _same_path(first: str, second: str) -> bool:
    return os.path.normcase(os.path.realpath(first)) == os.path.normcase(
        os.path.realpath(second)
    )


def _listeners(ports: Iterable[int]) -> dict[int, set[int | None]]:
    selected = set(ports)
    found: dict[int, set[int | None]] = {}
    for conn in psutil.net_connections(kind="tcp"):
        if conn.status != psutil.CONN_LISTEN or not conn.laddr:
            continue
        port = conn.laddr.port
        if port in selected:
            found.setdefault(port, set()).add(conn.pid)
    return found


def api_port_in_use(port: int) -> bool:
    """Prevent starting a duplicate bridge BEFORE it spawns MediaMTX."""
    try:
        return bool(_listeners((port,)))
    except (OSError, psutil.Error):
        # Return false here to allow Uvicorn to report its own bind error.
        return False


def _verified_orphan(pid: int, exe: str, config: str) -> bool:
    """Require exact executable, exact YAML and a dead/unavailable parent."""
    try:
        proc = psutil.Process(pid)
        if not _same_path(proc.exe(), exe):
            return False
        argv = proc.cmdline()
        if len(argv) != 2 or not _same_path(argv[0], exe):
            return False
        if not _same_path(argv[1], config):
            return False
        # Windows retains the old parent PID for orphaned child processes.
        # psutil returns None when that parent no longer exists (or its PID was
        # reused by a younger process). Do not interfere with live bridges.
        return proc.parent() is None
    except (OSError, psutil.Error, IndexError, TypeError, ValueError):
        return False


def recover_media_ports(exe: str, config: str) -> PortRecovery:
    """Reap only verified orphaned MSDS MediaMTX; never kill arbitrary listeners."""
    if not os.path.isfile(config):
        return PortRecovery(error="MediaMTX config file not found.")
    try:
        listeners = _listeners(MEDIA_TCP_PORTS)
    except (OSError, psutil.Error) as exc:
        return PortRecovery(error=f"Could not inspect local service ports: {exc}")

    if not listeners:
        return PortRecovery()

    pids = {pid for owners in listeners.values() for pid in owners}
    reclaimed: list[int] = []
    for pid in sorted(p for p in pids if isinstance(p, int) and p > 0):
        if not _verified_orphan(pid, exe, config):
            continue
        try:
            proc = psutil.Process(pid)
            # Recheck the exact process identity before terminating it.
            if not _verified_orphan(pid, exe, config):
                continue
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except psutil.TimeoutExpired:
                # Force only this same, verified orphan; no process tree kill.
                if not _verified_orphan(pid, exe, config):
                    continue
                proc.kill()
                proc.wait(timeout=3)
            reclaimed.append(pid)
        except (OSError, psutil.Error):
            continue

    try:
        remaining = _listeners(MEDIA_TCP_PORTS)
    except (OSError, psutil.Error) as exc:
        return PortRecovery(
            reclaimed=tuple(reclaimed),
            error=f"Could not recheck local service ports: {exc}",
        )

    blockers = [
        f"port {port} (PID {pid if pid is not None else 'unknown'})"
        for port, owners in sorted(remaining.items())
        for pid in sorted(owners, key=lambda v: -1 if v is None else v)
    ]
    return PortRecovery(reclaimed=tuple(reclaimed), blockers=tuple(blockers))
