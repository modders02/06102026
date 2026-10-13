"""Train the shared English MSDS KWS model from the COMPUTER microphone.

This command does not require a CCTV camera or MediaMTX. Every connected CCTV
uses the same model once loaded by the local camera service.

  python local-server/enroll_machine_kws.py --list-devices
  python local-server/enroll_machine_kws.py --keyword help --samples 5
  python local-server/enroll_machine_kws.py --keyword unknown --samples 10
  python local-server/enroll_machine_kws.py --keyword help --verify

Install the optional computer-microphone driver:
  python -m pip install -r local-server/requirements-machine-kws.txt

Each sample requires explicit human label approval. No continuous recording,
raw audio history, or external speech services are used.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import time
import urllib.error
import urllib.request
import wave
from pathlib import Path
from typing import Callable, Optional

import numpy as np

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from msds.kws_engine import (  # noqa: E402
    DEFAULT_KEYWORDS, KWS_ENGINE, MAX_NEGATIVE_TEMPLATES, MAX_TEMPLATES,
    NEGATIVE_CLASS, SAMPLE_RATE, StreamingSpeechSegmenter,
)
from train_english_kws import backup_templates  # noqa: E402

KEYWORDS = (*DEFAULT_KEYWORDS, NEGATIVE_CLASS)
BLOCK_SAMPLES = SAMPLE_RATE // 10  # 100 ms mono signed 16-bit PCM
MAX_WAIT_SECONDS = 10


class MachineEnrollmentError(RuntimeError):
    """A failed capture, validation, or local-model preflight."""


def microphone_module():
    """Import sounddevice only for computer-mic operations; CCTV is independent."""
    try:
        import sounddevice as sd
    except (ImportError, OSError) as exc:
        raise MachineEnrollmentError(
            "Computer microphone support is not installed. Run "
            ' & $py -m pip install -r ".\\local-server\\requirements-machine-kws.txt" '
            "in PowerShell."
        ) from exc
    return sd


def list_devices(out=print) -> None:
    sd = microphone_module()
    count = 0
    for index, device in enumerate(sd.query_devices()):
        if device["max_input_channels"] > 0:
            out(f"{index}: {device['name']} (input channels: {device['max_input_channels']})")
            count += 1
    if not count:
        raise MachineEnrollmentError(
            "No recording device found. Attach/enable a Windows microphone and check privacy permissions."
        )


def microphone_device(value: Optional[str]):
    if value is None:
        return None  # PortAudio default recording device
    try:
        return int(value)
    except ValueError:
        return value  # PortAudio matches a device-name substring


def check_speech(pcm: bytes) -> None:
    """Reject silence, clipping and implausible durations, not just any VAD trigger."""
    duration = len(pcm) / (SAMPLE_RATE * 2)
    if duration < 0.30 or duration > 2.55:
        raise MachineEnrollmentError(
            "Invalid speech duration: say one short word, then stop speaking."
        )
    samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
    if samples.size == 0:
        raise MachineEnrollmentError("Empty microphone recording.")
    peak = float(np.max(np.abs(samples)))
    rms = float(np.sqrt(np.mean(samples * samples)))
    clipped = float(np.mean(np.abs(samples) >= 0.985))
    if peak < 0.035 or rms < 0.015:
        raise MachineEnrollmentError("Audio too quiet. Speak clearly near the computer microphone.")
    if clipped > 0.02:
        raise MachineEnrollmentError("Microphone is clipping. Reduce its input volume.")


def capture_machine_word(device=None, wait: float = MAX_WAIT_SECONDS, out=print) -> bytes:
    """Read the selected local mic as exactly the same 16 kHz s16 PCM as CCTV."""
    sd = microphone_module()
    segmenter = StreamingSpeechSegmenter()
    try:
        with sd.RawInputStream(samplerate=SAMPLE_RATE, channels=1, dtype="int16",
                               blocksize=BLOCK_SAMPLES, device=device) as mic:
            # Discard start-up transients from device initialization.
            for _ in range(2):
                mic.read(BLOCK_SAMPLES)
            out("LISTENING — speak ONE word into your COMPUTER microphone, then be silent...")
            end = time.monotonic() + wait
            while time.monotonic() < end:
                data, overflow = mic.read(BLOCK_SAMPLES)
                if overflow:
                    raise MachineEnrollmentError(
                        "Microphone buffer overflow; close other recording apps and try again."
                    )
                segments = segmenter.feed(bytes(data))
                if segments:
                    speech = segments[0]
                    check_speech(speech)
                    return speech
    except MachineEnrollmentError:
        raise
    except Exception as exc:
        raise MachineEnrollmentError(
            f"Cannot capture computer microphone at 16 kHz mono: {exc}. "
            "Run --list-devices and select a compatible --device ID, "
            "or enable Windows microphone permissions."
        ) from exc
    raise MachineEnrollmentError(
        "No completed spoken word within the timeout. Check the microphone, "
        "speak once after LISTENING, then pause for silence."
    )


def approve_sample(pcm: bytes, label: str, input_fn=input, out=print,
                   playback: bool = True) -> bool:
    """Verify the spoken label before committing a feature template."""
    with tempfile.TemporaryDirectory(prefix="msds-mic-review-") as folder:
        wav_path = Path(folder) / "review.wav"
        with wave.open(str(wav_path), "wb") as writer:
            writer.setnchannels(1)
            writer.setsampwidth(2)
            writer.setframerate(SAMPLE_RATE)
            writer.writeframes(pcm)
        if playback and sys.platform == "win32":
            try:
                import winsound
                out("Replaying this recording for label review...")
                winsound.PlaySound(str(wav_path), winsound.SND_FILENAME)
            except (OSError, RuntimeError):
                out("Windows playback failed. Do not approve an uncertain recording.")
        out(f"Expected label: {label.upper()} "
            f"({'a non-emergency word' if label == NEGATIVE_CLASS else 'the exact keyword'})")
        answer = input_fn("Did the recording contain ONLY the intended word? [y/N]: ")
        return answer.strip().lower() in ("y", "yes")


def _bridge_request(url: str, method="GET") -> dict:
    req = urllib.request.Request(url, method=method,
                                 data=b"" if method == "POST" else None,
                                 headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as response:
        result = json.load(response)
    if not isinstance(result, dict):
        raise MachineEnrollmentError("Invalid local MSDS API response.")
    return result


def active_bridge(base: str, data_dir: Path) -> bool:
    """Refuse accidentally training another project's model when a bridge is live."""
    try:
        status = _bridge_request(base + "/kws/status")
    except (urllib.error.URLError, TimeoutError) as exc:
        # Connection-refused means offline training; other HTTP errors are fatal.
        if isinstance(exc, urllib.error.HTTPError):
            raise MachineEnrollmentError(
                "The running MSDS bridge lacks /kws/status. Restart the updated bridge."
            ) from exc
        try:
            import socket
            if isinstance(exc.reason, ConnectionRefusedError):
                return False
            if isinstance(exc.reason, OSError) and exc.reason.errno in (10061, 111, 61):
                return False
        except (AttributeError, TypeError):
            pass
        raise MachineEnrollmentError(f"Unable to verify local MSDS bridge: {exc}") from exc

    server_path = status.get("data_dir")
    if not server_path:
        raise MachineEnrollmentError("Bridge did not return the active KWS template path.")
    if Path(server_path).resolve() != data_dir.resolve():
        raise MachineEnrollmentError(
            f"The live bridge uses a DIFFERENT model directory: {server_path}. "
            f"This CLI would train {data_dir}. Stop the other bridge and "
            "start camera_server.py from this project, or set MSD_KWS_DATA_DIR "
            "to the active path before enrollment."
        )
    try:
        openapi = _bridge_request(base + "/openapi.json")
        if "/kws/reload-local" not in openapi.get("paths", {}):
            raise MachineEnrollmentError(
                "The running camera bridge is an older version without model reload. "
                "Restart it from the updated project before machine enrollment."
            )
    except urllib.error.URLError as exc:
        raise MachineEnrollmentError("Cannot confirm model reload support in the running bridge.") from exc
    return True


def reload_bridge(base: str) -> dict:
    try:
        response = _bridge_request(base + "/kws/reload-local", method="POST")
    except (urllib.error.URLError, TimeoutError) as exc:
        raise MachineEnrollmentError(
            "The sample was saved, but the running camera service could not "
            "reload it. Restart camera_server.py to load the trained templates."
        ) from exc
    if not response.get("success"):
        raise MachineEnrollmentError(
            "Sample saved, but model reload failed: " + str(response.get("error"))
        )
    return response


def session(engine, keyword: str, samples: int, *, verify: bool = False,
            device=None, input_fn=input, out=print,
            capture: Callable = capture_machine_word,
            review: Callable = approve_sample,
            backup: Callable = backup_templates,
            bridge_base: str = "http://127.0.0.1:5000",
            check_bridge: Callable = active_bridge,
            notify_bridge: Callable = reload_bridge,
            playback: bool = True) -> int:
    """Enter -> capture -> approve -> enroll, without any CCTV camera."""
    key = engine.normalize_keyword(keyword)
    if key not in KEYWORDS:
        raise MachineEnrollmentError(f"Unsupported English KWS label {keyword!r}.")
    model_dir = Path(engine.data_dir)
    live = check_bridge(bridge_base, model_dir)
    engine.load()  # See external updates before any capacity check.
    maximum = MAX_NEGATIVE_TEMPLATES if key == NEGATIVE_CLASS else MAX_TEMPLATES
    saved = len(engine.templates.get(key, []))

    if verify:
        out("VALIDATION ONLY — no templates will be written.")
        input_fn("Press ENTER when ready to say the word for validation: ")
        speech = capture(device=device, out=out)
        decision = engine.diagnose(speech)
        status = engine.status()
        if not status["open_set_ready"]:
            out("NOT READY: Train at least 3 keyword and 5 UNKNOWN examples, "
                "then validate against unseen speech and background noise.")
        if decision is None:
            out("REJECTED — no usable keyword classification.")
        else:
            out(f"Detected candidate: {decision.keyword.upper()} | "
                f"confidence={decision.confidence:.3f} | "
                f"decision={'ACCEPTED' if decision.accepted else 'REJECTED'} "
                f"({decision.reason})")
        passed = bool(decision and decision.accepted and decision.keyword == key
                      and status["open_set_ready"])
        out("MATCH" if passed else "NO MATCH — adjust dataset, do not enable alerts yet.")
        return 0 if passed else 2

    if not 1 <= samples <= maximum:
        raise MachineEnrollmentError(f"Samples must be between 1 and {maximum}.")
    if saved + samples > maximum:
        raise MachineEnrollmentError(
            f"Shared {key!r} model has {saved}/{maximum} templates. "
            f"At most {maximum - saved} new samples fit. No existing sample will be replaced."
        )

    archive = backup(model_dir, HERE / "kws-backups")
    out(f"Existing model backup: {archive}")
    out(f"Computer microphone enrollment, label={key.upper()}, "
        f"existing={saved}/{maximum}, new recordings={samples}")
    out("No CCTV or MediaMTX needed. Templates will be shared by ALL CCTV cameras.")
    out("Disable external emergency notifications for this training session.")
    out("For UNKNOWN, say different NON-emergency words/phrases.")
    completed, attempts = 0, 0
    while completed < samples:
        answer = input_fn(
            f"\n[{completed + 1}/{samples}] Press ENTER to record {key.upper()} "
            "using COMPUTER microphone, or q to quit: "
        ).strip().lower()
        if answer in ("q", "quit"):
            break
        attempts += 1
        try:
            speech = capture(device=device, out=out)
            if not review(speech, key, input_fn=input_fn, out=out, playback=playback):
                out("DISCARDED — no model template saved.")
            else:
                engine.load()
                # The engine's original enroll() evicts the oldest template at
                # capacity, so guard the filesystem before every call.
                raw_count = len(list((model_dir / key).glob("*.npy")))
                if (raw_count >= maximum or
                        len(engine.templates.get(key, [])) >= maximum):
                    raise MachineEnrollmentError(
                        "Shared template capacity was reached during enrollment; "
                        "stopping without overwriting any existing sample."
                    )
                result = engine.enroll(key, speech)
                completed += 1
                out(f"SAVED {key.upper()} — {result['templates']}/{maximum} "
                    f"shared model templates ({completed}/{samples} new).")
                if live:
                    notify_bridge(bridge_base)
                    out("Running MSDS bridge reloaded this shared model.")
                else:
                    out("Bridge is offline. Restart camera_server.py before CCTV validation.")
        except MachineEnrollmentError as exc:
            if "capacity" in str(exc) or "reload" in str(exc):
                raise
            out(f"NOT SAVED: {exc}")
        if attempts >= samples * 6 and completed < samples:
            out("Too many failed recording attempts. Verify computer microphone input.")
            break
    out(f"Enrollment completed: {completed} accepted machine-microphone recordings.")
    return 0 if completed == samples else 2


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Enroll/validate one English KWS word from the LOCAL COMPUTER microphone."
    )
    parser.add_argument("--keyword", choices=KEYWORDS)
    parser.add_argument("--samples", type=int, default=5,
                        help="Number of accepted model templates; shared across cameras.")
    parser.add_argument("--device", help="Computer microphone device index or name.")
    parser.add_argument("--list-devices", action="store_true")
    parser.add_argument("--verify", action="store_true",
                        help="Validate a NEW recording without modifying model templates.")
    parser.add_argument("--no-playback", action="store_true",
                        help="Skip Windows playback, still require sample label approval.")
    parser.add_argument("--port", type=int, default=int(os.environ.get("MSD_API_PORT", "5000")))
    args = parser.parse_args()
    try:
        if args.list_devices:
            list_devices()
            return 0
        if not args.keyword:
            parser.error("--keyword is required unless --list-devices is used")
        if not 1 <= args.port <= 65535:
            parser.error("--port must be between 1 and 65535")
        microphone_module()  # Fail early, before writing backups.
        return session(
            KWS_ENGINE, args.keyword, args.samples, verify=args.verify,
            device=microphone_device(args.device), playback=not args.no_playback,
            bridge_base=f"http://127.0.0.1:{args.port}",
        )
    except (MachineEnrollmentError, ValueError, OSError) as exc:
        print(f"Machine enrollment stopped: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\nStopped. No incomplete sample was saved.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
