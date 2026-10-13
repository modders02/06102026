"""Interactive CCTV English KWS enrollment, using the original MSDS endpoint.

Run while the MSDS camera bridge and a connected CCTV microphone are active:

    python local-server/enroll_english_kws.py --keyword help --samples 5
    python local-server/enroll_english_kws.py --camera all --keyword help --samples 5
    python local-server/enroll_english_kws.py --camera slot-3 --keyword unknown --samples 10

The default --camera auto selects a connected CCTV microphone; --camera all
cycles through the available cameras, one at a time, for the specified TOTAL
number of templates (not samples per camera). All connected cameras use the
same global keyword model, regardless of where training was recorded.

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

    def ready_camera_ids(self) -> list[str]:
        """List every registered CCTV currently streaming usable PCM audio.

        Model templates are shared across cameras. These IDs identify speech
        *sources* for the interactive capture, not independent KWS models.
        """
        status = request_json(f"{self.base}/status")
        if not status.get("mediamtx"):
            detail = status.get("mediamtx_error") or "MediaMTX is not running"
            raise EnrollmentError(f"MediaMTX is unavailable: {detail}")
        ready = []
        registered = []
        for cam in status.get("cameras", []):
            camera_id = cam.get("id")
            if not isinstance(camera_id, str) or not camera_id:
                continue
            registered.append(camera_id)
            audio = cam.get("audio") or {}
            if (cam.get("enabled") and cam.get("ffmpeg")
                    and audio.get("has_audio_track") is not False
                    and audio.get("thread_running") and audio.get("connected")):
                ready.append(camera_id)
        if not ready:
            raise EnrollmentError(
                f"No connected CCTV microphone is ready. Registered camera IDs: {registered!r}. "
                "Connect the desired cameras in MSDS and verify /status shows "
                "audio.thread_running=True and audio.connected=True."
            )
        return ready

    def camera_status(self) -> dict:
        status = request_json(f"{self.base}/status")
        cam = next((camera for camera in status.get("cameras", [])
                    if camera.get("id") == self.camera), None)
        if not cam:
            ids = [camera.get("id") for camera in status.get("cameras", [])]
            raise EnrollmentError(f"Camera {self.camera!r} not found; connected IDs: {ids!r}")
        if not status.get("mediamtx"):
            detail = status.get("mediamtx_error") or "MediaMTX is not running"
            raise EnrollmentError(f"MediaMTX is unavailable: {detail}")
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
                  input_fn=input, out=print,
                  camera_ids: list[str] | None = None) -> int:
    """Record a shared model from any or all ready cameras, sequentially.

    samples is a TOTAL budget. All cameras write the same KWS template pool,
    so the maximum is still 10 positive or 40 unknown, not per camera.
    """
    selected = list(camera_ids if camera_ids is not None else [client.camera])
    if not selected or len(selected) != len(set(selected)):
        raise EnrollmentError("Specify at least one unique registered camera ID.")
    if samples < len(selected):
        raise EnrollmentError(
            f"{len(selected)} cameras were selected, but only {samples} total samples "
            "were requested. Increase --samples to at least the camera count "
            "(within the shared model limit), or use --camera auto/specific ID. "
            "Recognition already runs on all connected cameras after training."
        )
    # Check each microphone BEFORE creating a backup or arming a capture.
    for camera_id in selected:
        client.camera = camera_id
        client.camera_status()
    client.camera = selected[0]
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
    out(f"Cameras: {', '.join(selected)} | label: {keyword.upper()} | total recordings: {samples}")
    out("One shared KWS model is used for detection on ALL connected CCTV cameras.")
    if len(selected) > 1:
        out("For each take, speak toward the specific camera named in the prompt.")
    out(f"Existing templates: {saved}/{maximum}")
    out("Every successful recording immediately becomes a model template.")
    out("No audio playback or word verification is available in the original mode.")
    out("Disable external emergency notifications and use consenting speakers only.")
    done = 0
    while done < samples:
        client.camera = selected[done % len(selected)]
        answer = input_fn(
            f"\n[{done + 1}/{samples}] CCTV {client.camera}: press ENTER to enroll "
            f"'{keyword}', or q to finish: "
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
            out(f"LISTENING on {client.camera} — say '{keyword}' ONCE "
                "toward this camera, then remain silent...")
            saved = wait_for_capture(client, keyword, previous)
        except BaseException:
            try:
                client.cancel()
            except EnrollmentError:
                pass
            raise
        done += 1
        out(f"SAVED from {client.camera}: {keyword.upper()} sample {saved}/{maximum}; "
            f"completed {done}/{samples} this session.")
        out("Stay quiet until you press Enter for the next recording.")
    out(f"Session complete: {done} new enrollment(s).")
    return done


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Old-style Enter -> speak -> repeat interactive CCTV enrollment."
    )
    parser.add_argument(
        "--camera", default="auto",
        help="Registered camera ID, 'auto' for the first ready CCTV (default), "
             "or 'all' to rotate captures across every ready CCTV",
    )
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
        if args.camera in ("auto", "all"):
            ready = client.ready_camera_ids()
            selected = ready[:1] if args.camera == "auto" else ready
        else:
            selected = [args.camera]
        do_enrollment(client, args.keyword, args.samples, camera_ids=selected)
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
