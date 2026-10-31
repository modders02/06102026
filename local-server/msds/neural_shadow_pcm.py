"""Opt-in transient PCM tap for the standalone neural KWS shadow experiment.

Provides one bounded in-memory subscriber per camera. Never writes audio to
disk, blocks the active DTW stream, or accepts keyword decisions from clients.
The HTTP endpoint is separately protected by loopback/origin restrictions.
"""
from __future__ import annotations

import hmac
import os
import queue
import secrets
import threading


def enabled() -> bool:
    return os.environ.get("MSDS_KWS_SHADOW_PCM", "").strip().lower() in (
        "1", "true", "yes", "on",
    )


class ShadowPCMFeed:
    def __init__(self, queue_size: int = 64):
        self._lock = threading.Lock()
        self._subscriber: queue.Queue[bytes] | None = None
        self._lease_token: str | None = None
        self._queue_size = queue_size

    def subscribe(self) -> queue.Queue[bytes] | None:
        """Allow at most one local consumer per camera."""
        with self._lock:
            if self._subscriber is not None:
                return None
            subscription: queue.Queue[bytes] = queue.Queue(maxsize=self._queue_size)
            self._subscriber = subscription
            self._lease_token = secrets.token_urlsafe(24)
            return subscription

    def unsubscribe(self, subscription: queue.Queue[bytes]) -> None:
        with self._lock:
            if self._subscriber is subscription:
                self._subscriber = None
                self._lease_token = None

    def lease_for(self, subscription: queue.Queue[bytes]) -> str | None:
        """Give a capability only to the exact subscriber that acquired the feed."""
        with self._lock:
            return self._lease_token if self._subscriber is subscription else None

    def release_lease(self, token: str) -> bool:
        """Idempotently release the matching subscription; never evict another client."""
        with self._lock:
            if (not token or self._lease_token is None
                    or not hmac.compare_digest(token, self._lease_token)):
                return False
            self._subscriber = None
            self._lease_token = None
            return True

    def is_current(self, subscription: queue.Queue[bytes]) -> bool:
        with self._lock:
            return self._subscriber is subscription

    def publish(self, pcm: bytes) -> None:
        """Drop the subscriber on overflow; never block DTW or lose audio silently.

        The disconnected consumer must reconnect and reset its neural stream,
        rather than decoding disjoint chunks as continuous speech.
        """
        with self._lock:
            subscription = self._subscriber
            if subscription is None or not pcm:
                return
            try:
                subscription.put_nowait(pcm)
            except queue.Full:
                self._subscriber = None
                self._lease_token = None

    def disconnect(self) -> None:
        """Invalidate any listener when a camera stops or is reconfigured."""
        with self._lock:
            self._subscriber = None
            self._lease_token = None

    def has_subscriber(self) -> bool:
        with self._lock:
            return self._subscriber is not None
