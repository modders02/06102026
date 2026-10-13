"""Interactive CCTV English KWS enrollment, using the original MSDS endpoint.

Run while the MSDS camera bridge and a connected CCTV microphone are active:

    python local-server/enroll_english_kws.py --camera slot-1 --keyword help --samples 5
    python local-server/enroll_english_kws.py --camera slot-1 --keyword unknown --samples 10

Press Enter before *each* utterance. The script arms exactly one enrollment,
waits for the CCTV VAD to capture the phrase, confirms the saved template
count, and only then offers the next take. No direct FFmpeg/RTSP access and
no microphone recording from the terminal itself.

The legacy endpoint saves a feature template immediately when VAD triggers;
it does NOT offer playback or approve/reject controls. Only use with
consenting speakers in a controlled recording environment.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from msds.kws_engine import (  # noqa: E402
    DEFAULT_KEYWORDS, MAX_NEGATIVE_TEMPLATES, MAX_TEMPLATES, NEGATIVE_CLASS,
)
from train_english_kws import backup_templates  # noqa: E402

KEYWORDS = (*DEFAULT_KEYWORDS, NEGATIVE_CLASS)


class EnrollmentError(RuntimeError):
    """Helpful error from the local camera bridge or enrollment workflow."""


def request_json(url: str, method: str = "GET") -> dict:
    """Make a local-only API request; never send camera credentials or audio."""
    request = urllib.request.Request(
        url, method=method, data=b"" if method == "POST" else None,
        headers={"Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            result = json.load(response)
    except urllib.error.HTTPError as exc:
        try:
            detail = json.load(exc).get("detail", "unknown error")
        except Exception:
            detail = str(exc)
        raise EnrollmentError(f"MSDS returned HTTP {exc.code}: {detail}") from exc
    except (OSError, ValueError) as exc:
        raise EnrollmentError(
            "Cannot reach the local MSDS bridge at 127.0.0.1. "
            "Start camera_server.py and connect your CCTV."
        ) from exc
    if not isinstance(result, dict):
        raise EnrollmentError("MSDS returned an unexpected response.")
    if result.get("success") is False:
        raise EnrollmentError(str(result.get("error") or "request failed"))
    return result


class EnrollmentClient:
    def __init__(self, camera: str, port: int = 5000) -> None:
        self.camera = camera
        self.base = f"http://127.0.0.1:{port}"

    def camera_status(self) -> dict:
        status = request_json(f"{self.base}/status")
        cam = next((camera for camera in status.get("cameras", [])
                    if camera.get("id") == self.camera), None)
        if not cam:
            ids = [camera.get("id") for camera in status.get("cameras", [])]
            raise EnrollmentError(f"Camera {self.camera!r} not found; connected IDs: {ids!r}")
        if not status.get("mediamtx"):
            raise EnrollmentError(
                "MediaMTX is not running. Install it into local-server/bin "
                "using fetch_binaries.py, then restart the camera bridge."
            )
        if not cam.get("enabled") or not cam.get("ffmpeg"):
            raise EnrollmentError("This CCTV is not connected. Start it in MSDS first.")
        audio = cam.get("audio") or {}
        if audio.get("has_audio_track") is False:
            raise EnrollmentError("Camera RTSP stream has no audio track. Enable its microphone.")
        if not audio.get("thread_running") or not audio.get("connected"):
            raise EnrollmentError(
                "CCTV microphone is not receiving audio yet. Wait until "
                "/status shows audio.thread_running and audio.connected = True."
            )
        return status

    def kws_status(self) -> dict:
        return request_json(f"{self.base}/kws/status")

    def start(self, keyword: str) -> dict:
        return request_json(
            f"{self.base}/cameras/{self.camera}/kws-enroll/{keyword}", method="POST"
        )

    def cancel(self) -> None:
        request_json(f"{self.base}/cameras/{self.camera}/kws-enroll-cancel", method="POST")

    def state(self) -> dict:
        status = request_json(f"{self.base}/status")
        cam = next((c for c in status.get("cameras", [])
                    if c.get("id") == self.camera), None)
        if not cam:
            raise EnrollmentError("CCTV disconnected while enrolling.")
        audio = cam.get("audio") or {}
        kws = audio.get("custom_kws") or {}
        return kws.get("enrollment") or {}


def wait_for_capture(client: EnrollmentClient, keyword: str, previous: int,
                     timeout: float = 20, interval: float = 0.4) -> int:
    """Poll the *original* enrollment status until one template is committed."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        state = client.state()
        stage = state.get("state")
        if stage == "error":
            raise EnrollmentError(str(state.get("message") or "CCTV enrollment failed"))
        if stage == "captured":
            if state.get("keyword") != keyword:
                raise EnrollmentError("Captured a different label; stop to inspect your model.")
            count = int(state.get("templates", -1))
            if count <= previous:
                raise EnrollmentError("Capture reported but model template count did not increase.")
            return count
        if stage not in ("waiting",):
            raise EnrollmentError(
                "The enrollment was cancelled, interrupted, or reset before capturing audio."
            )
        time.sleep(interval)
    raise EnrollmentError(
        "Timed out waiting for a complete spoken segment. "
        "Check the CCTV audio track, microphone gain, and background noise."
    )


def do_enrollment(client: EnrollmentClient, keyword: str, samples: int,
                  input_fn=input, out=print) -> int:
    """Interactive Enter -> speech -> auto-save loop; no implicit sample deletion."""
    status = client.camera_status()
    kws = client.kws_status()
    active_dir = kws.get("data_dir")
    if not active_dir or not Path(active_dir).is_absolute():
        raise EnrollmentError("MSDS did not provide an absolute local template data directory.")
    source = Path(active_dir)
    if not source.exists() and (kws.get("keywords") or {}):
        raise EnrollmentError("MSDS template path is missing; refusing to enroll without a backup.")

    archive = backup_templates(source, HERE / "kws-backups")
    out(f"Model backup created: {archive}")
    saved = int((kws.get("keywords") or {}).get(keyword, 0))
    maximum = MAX_NEGATIVE_TEMPLATES if keyword == NEGATIVE_CLASS else MAX_TEMPLATES
    if saved >= maximum:
        raise EnrollmentError(
            f"'{keyword}' already has {saved}/{maximum} templates. "
            "Old enrollment replaces the oldest at capacity; refusing to delete it."
        )
    if saved + samples > maximum:
        raise EnrollmentError(
            f"Requested {samples}, but {keyword!r} has {saved}/{maximum}. "
            f"Request at most {maximum - saved} or inspect the trained samples."
        )
    out("MSDS original terminal enrollment (CCTV microphone)")
    out(f"Camera: {client.camera} | label: {keyword.upper()} | requested: {samples}")
    out(f"Existing templates: {saved}/{maximum}")
    out("Every successful recording immediately becomes a model template.")
    out("No audio playback or word verification is available in the original mode.")
    out("Disable external emergency notifications and use consenting speakers only.")
    done = 0
    while done < samples:
        answer = input_fn(
            f"\n[{done + 1}/{samples}] Press ENTER to enroll '{keyword}', or q to finish: "
        ).strip().lower()
        if answer in ("q", "quit"):
            out("Finished early; previously captured templates remain saved.")
            break
        # External enrollments could have modified templates while prompting.
        current = client.kws_status()
        previous = int((current.get("keywords") or {}).get(keyword, 0))
        if previous >= maximum:
            raise EnrollmentError("Maximum template count reached; refusing to replace old data.")
        client.camera_status()
        try:
            result = client.start(keyword)
            if result.get("state") != "waiting":
                raise EnrollmentError("MSDS did not arm the camera enrollment.")
            out(f"LISTENING — say '{keyword}' ONCE toward CCTV, then remain silent...")
            saved = wait_for_capture(client, keyword, previous)
        except BaseException:
            try:
                client.cancel()
            except EnrollmentError:
                pass
            raise
        done += 1
        out(f"SAVED: {keyword.upper()} sample {saved}/{maximum}; "
            f"completed {done}/{samples} this session.")
        out("Stay quiet until you press Enter for the next recording.")
    out(f"Session complete: {done} new enrollment(s).")
    return done


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Old-style Enter -> speak -> repeat interactive CCTV enrollment."
    )
    parser.add_argument("--camera", default="slot-1", help="CCTV ID in local /status")
    parser.add_argument("--keyword", required=True, choices=KEYWORDS)
    parser.add_argument("--samples", "--count", dest="samples", type=int, default=5,
                        help="Number of new enrolled takes (default: 5)")
    parser.add_argument("--port", type=int, default=int(os.environ.get("MSD_API_PORT", "5000")),
                        help="Local MSDS API port (default 5000)")
    args = parser.parse_args()
    if not 1 <= args.samples <= MAX_NEGATIVE_TEMPLATES:
        parser.error(f"--samples must be between 1 and {MAX_NEGATIVE_TEMPLATES}")
    if not 1 <= args.port <= 65535:
        parser.error("--port must be a valid local TCP port")
    client = EnrollmentClient(args.camera, args.port)
    try:
        do_enrollment(client, args.keyword, args.samples)
    except KeyboardInterrupt:
        try:
            client.cancel()
        except EnrollmentError:
            pass
        print("\nStopped. No additional enrollment was armed.", file=sys.stderr)
        return 130
    except EnrollmentError as exc:
        print(f"Enrollment stopped: {exc}", file=sys.stderr)
        return 1
    except OSError as exc:
        print(f"Enrollment stopped: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
