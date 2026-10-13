"""No-hardware regression tests for COMPUTER-microphone MSDS KWS enrollment."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
from fastapi import HTTPException
from starlette.requests import Request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import enroll_machine_kws as machine
from msds import api


def voice_pcm(seconds=0.7, frequency=320):
    x = np.arange(int(machine.SAMPLE_RATE * seconds), dtype=np.float64)
    return (0.16 * np.sin(2 * np.pi * frequency * x / machine.SAMPLE_RATE)
            * 32767).astype("<i2").tobytes()


class FakeEngine:
    def __init__(self, directory):
        self.data_dir = Path(directory)
        self.templates = {}
        self.writes = 0
        self.trained_on = []

    def normalize_keyword(self, keyword):
        return keyword

    def load(self):
        pass

    def status(self):
        return {"open_set_ready": True}

    def enroll(self, label, pcm):
        self.writes += 1
        self.trained_on.append((label, bytes(pcm)))
        self.templates.setdefault(label, []).append(object())
        return {"templates": len(self.templates[label]), "ready": False}

    def diagnose(self, pcm):
        return SimpleNamespace(keyword="help", accepted=True,
                               confidence=0.82, reason="accepted")


class MicrophoneTests(unittest.TestCase):
    def test_quality_rejects_silence_clipping_and_short_audio(self):
        machine.check_speech(voice_pcm())
        with self.assertRaisesRegex(machine.MachineEnrollmentError, "quiet"):
            machine.check_speech(b"\x00\x00" * 13000)
        with self.assertRaisesRegex(machine.MachineEnrollmentError, "clipping"):
            machine.check_speech((b"\xff\x7f" * 12000))
        with self.assertRaisesRegex(machine.MachineEnrollmentError, "duration"):
            machine.check_speech(voice_pcm(0.1))

    def test_raw_microphone_uses_same_streaming_vad_as_camera(self):
        silence = b"\x00\x00" * machine.BLOCK_SAMPLES
        audio = voice_pcm(0.1)
        blocks = [silence] * 3 + [audio] * 7 + [silence] * 5
        class FakeStream:
            def __enter__(self):
                self.idx = 0
                return self
            def __exit__(self, *_):
                pass
            def read(self, count):
                value = blocks[self.idx] if self.idx < len(blocks) else silence
                self.idx += 1
                return value, False
        class FakeSD:
            def RawInputStream(self, **kwargs):
                self.params = kwargs
                return FakeStream()
        device = FakeSD()
        with patch.object(machine, "microphone_module", return_value=device):
            result = machine.capture_machine_word(device=2, out=lambda _: None)
        self.assertGreater(len(result), 9000)
        self.assertEqual(device.params["samplerate"], 16000)
        self.assertEqual(device.params["dtype"], "int16")
        self.assertEqual(device.params["channels"], 1)
        self.assertEqual(device.params["device"], 2)

    def test_rejected_label_cannot_be_saved(self):
        with tempfile.TemporaryDirectory() as temp:
            engine = FakeEngine(temp)
            answers = iter(["", "q"])
            code = machine.session(
                engine, "help", 1, input_fn=lambda _: next(answers),
                capture=lambda **_: voice_pcm(),
                review=lambda *a, **k: False,
                out=lambda _: None,
                backup=lambda *_: Path(temp) / "backup.zip",
                check_bridge=lambda *_: False,
            )
            self.assertEqual(code, 2)
            self.assertEqual(engine.writes, 0)

    def test_accepted_samples_are_shared_without_any_camera(self):
        with tempfile.TemporaryDirectory() as temp:
            engine = FakeEngine(temp)
            reloaded = []
            outputs = []
            code = machine.session(
                engine, "help", 2, input_fn=lambda _: "",
                capture=lambda **_: voice_pcm(),
                review=lambda *a, **k: True,
                out=outputs.append,
                backup=lambda *_: Path(temp) / "backup.zip",
                check_bridge=lambda *_: True,
                notify_bridge=lambda url: reloaded.append(url),
            )
            self.assertEqual(code, 0)
            self.assertEqual(engine.writes, 2)
            self.assertEqual([key for key, _ in engine.trained_on], ["help", "help"])
            self.assertEqual(len(reloaded), 2)
            self.assertTrue(any("ALL CCTV cameras" in x for x in outputs))

    def test_shared_model_capacity_is_not_per_camera(self):
        with tempfile.TemporaryDirectory() as temp:
            engine = FakeEngine(temp)
            engine.templates["help"] = [object()] * machine.MAX_TEMPLATES
            with self.assertRaisesRegex(machine.MachineEnrollmentError, "At most 0"):
                machine.session(
                    engine, "help", 1,
                    backup=lambda *_: self.fail("Backup must not be made"),
                    check_bridge=lambda *_: False,
                )
            self.assertEqual(engine.writes, 0)

    def test_verify_does_not_save_or_create_backup(self):
        with tempfile.TemporaryDirectory() as temp:
            engine = FakeEngine(temp)
            logs = []
            code = machine.session(
                engine, "help", 5, verify=True,
                input_fn=lambda _: "",
                capture=lambda **_: voice_pcm(),
                out=logs.append,
                backup=lambda *_: self.fail("No backup expected for verification"),
                check_bridge=lambda *_: False,
            )
            self.assertEqual(code, 0)
            self.assertEqual(engine.writes, 0)
            self.assertTrue(any(x == "MATCH" for x in logs))

    def test_verify_rejects_a_model_without_unknown_class(self):
        with tempfile.TemporaryDirectory() as temp:
            engine = FakeEngine(temp)
            engine.status = lambda: {"open_set_ready": False}
            self.assertEqual(machine.session(
                engine, "help", 5, verify=True, input_fn=lambda _: "",
                capture=lambda **_: voice_pcm(), out=lambda _: None,
                check_bridge=lambda *_: False,
            ), 2)

    def test_live_bridge_on_different_project_path_must_fail(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(machine, "_bridge_request", return_value={
                "data_dir": str(Path(temp) / "different-project")
            }):
                with self.assertRaisesRegex(machine.MachineEnrollmentError,
                                            "DIFFERENT model directory"):
                    machine.active_bridge("http://127.0.0.1:5000", Path(temp) / "current")

    def test_live_old_bridge_without_reload_must_fail_before_recording(self):
        with tempfile.TemporaryDirectory() as temp:
            def fake_api(url, method="GET"):
                if url.endswith("/kws/status"):
                    return {"data_dir": temp}
                return {"paths": {}}
            with patch.object(machine, "_bridge_request", side_effect=fake_api):
                with self.assertRaisesRegex(machine.MachineEnrollmentError,
                                            "older version"):
                    machine.active_bridge("http://127.0.0.1:5000", Path(temp))

    def test_live_new_bridge_same_model_is_supported(self):
        with tempfile.TemporaryDirectory() as temp:
            def fake_api(url, method="GET"):
                if url.endswith("/kws/status"):
                    return {"data_dir": temp}
                return {"paths": {"/kws/reload-local": {"post": {}}}}
            with patch.object(machine, "_bridge_request", side_effect=fake_api):
                self.assertTrue(machine.active_bridge("http://127.0.0.1:5000", Path(temp)))


class ReloadLocalTests(unittest.TestCase):
    @staticmethod
    def request(host="127.0.0.1", headers=()):
        # starlette Request(scope=...) honors the socket peer, not X-Forwarded-For.
        return Request({"type": "http", "method": "POST", "scheme": "http",
                        "server": ("127.0.0.1", 5000), "path": "/kws/reload-local",
                        "headers": [(k.encode(), v.encode()) for k, v in headers],
                        "client": (host, 12345), "query_string": b"",
                        "http_version": "1.1"})

    def test_remote_peer_cannot_reload(self):
        with self.assertRaises(HTTPException) as ctx:
            api.kws_reload_local(self.request(host="192.168.0.25"))
        self.assertEqual(ctx.exception.status_code, 403)

    def test_browser_origin_cannot_reload(self):
        with self.assertRaises(HTTPException) as ctx:
            api.kws_reload_local(
                self.request(headers=[("origin", "https://untrusted.example")]))
        self.assertEqual(ctx.exception.status_code, 403)

    def test_loopback_cli_reloads_shared_engine(self):
        with patch.object(api.KWS_ENGINE, "load") as load, \
                patch.object(api.KWS_ENGINE, "status", return_value={
                    "ready_keywords": ["help"], "open_set_ready": True
                }):
            result = api.kws_reload_local(self.request())
        self.assertTrue(result["success"])
        self.assertTrue(result["open_set_ready"])
        load.assert_called_once()


if __name__ == "__main__":
    unittest.main()
