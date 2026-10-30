"""Read-only neural KWS test suite; no model, audio or FFmpeg required."""
from __future__ import annotations
import io
import os
import queue
import threading
from pathlib import Path
import sys
import tarfile
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
from neural_kws_trial import (  # noqa: E402
    CHUNK_BYTES, dtw_snapshot, make_ffmpeg_args, normalize_word,
    validate_camera, make_bridge_request, pcm_bridge_enabled,
)
from prepare_neural_kws import MODEL_NAME, safe_members, KEYWORDS  # noqa: E402
from msds.neural_shadow_pcm import ShadowPCMFeed, enabled as pcm_enabled  # noqa: E402


def connected_camera(path="slot-1"):
    return {"cameras": [{
        "id": "slot-1", "path": path, "enabled": True, "ffmpeg": True,
        "audio": {"connected": True, "thread_running": True, "custom_kws": {
            "last_candidate": "help", "last_decision": "duration_mismatch",
            "last_candidate_confidence": 0.73, "last_segment_at": "2026-10-30T00:00:00Z",
        }},
    }]}


class NeuralKwsShadowTests(unittest.TestCase):
    def test_tokenizer_runtime_dependency_declared(self):
        requirements = (HERE / "requirements-neural-kws.txt").read_text(encoding="utf-8")
        self.assertIn("sherpa-onnx==1.12.26", requirements)
        self.assertIn("sentencepiece==0.2.2", requirements)
        setup = (HERE / "setup_neural_kws_windows.cmd").read_text(encoding="utf-8")
        self.assertIn("import sentencepiece, sherpa_onnx", setup)
        self.assertNotIn("sherpa-onnx-cli.exe", setup)
        self.assertIn('set "PYTHONIOENCODING=utf-8"', setup)
        self.assertIn('set "PYTHONUTF8=1"', setup)
        prepare = (HERE / "prepare_neural_kws.py").read_text(encoding="utf-8")
        self.assertIn("SentencePieceProcessor", prepare)
        self.assertNotIn("subprocess.run", prepare)

    def test_bpe_keyword_format_and_vocabulary_validation(self):
        from prepare_neural_kws import encode_english_keywords, load_vocabulary
        import tempfile

        class FakeBpe:
            def encode(self, word, out_type=str):
                self.assertion = out_type
                return ["▁" + word[:2], word[2:]]

        pieces = {"▁" + w.upper()[:2] for w in KEYWORDS}
        pieces.update(w.upper()[2:] for w in KEYWORDS)
        lines = encode_english_keywords(FakeBpe(), pieces)
        self.assertEqual(len(lines), len(KEYWORDS))
        for word, line in zip(KEYWORDS, lines):
            self.assertIn(":1.0 #0.50 @" + word, line)
        self.assertIn("▁HE LP :1.0 #0.50 @help", lines)
        with self.assertRaises(ValueError):
            encode_english_keywords(FakeBpe(), {"▁HE"}, ("help",))
        with self.assertRaises(ValueError):
            encode_english_keywords(FakeBpe(), pieces, ("HELP",))
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "tokens.txt"
            p.write_text("▁HE 1\nLP 2\n", encoding="utf-8")
            self.assertEqual(load_vocabulary(p), {"▁HE", "LP"})
            p.write_text("▁HE 1\n▁HE 2\n", encoding="utf-8")
            with self.assertRaises(ValueError):
                load_vocabulary(p)

    def test_keywords_remain_enrolled_scope(self):
        self.assertEqual(KEYWORDS, ("help", "fire", "emergency", "danger",
                                    "intruder", "police", "ambulance"))
        for word in KEYWORDS:
            self.assertEqual(normalize_word(word.upper()), word)
        self.assertEqual(normalize_word("@HELP"), "help")
        self.assertIsNone(normalize_word("hello"))
        self.assertIsNone(normalize_word("help me"))
        self.assertIsNone(normalize_word("police intruder"))

    def test_selected_local_relay_only(self):
        camera = connected_camera()
        self.assertEqual(validate_camera(camera, "slot-1"), "slot-1")
        args = make_ffmpeg_args("ffmpeg.exe", "slot-1", 8554)
        self.assertIn("rtsp://127.0.0.1:8554/slot-1", args)
        self.assertIn("0:a:0", args)
        self.assertEqual(CHUNK_BYTES, 6400)
        with self.assertRaises(ValueError):
            make_ffmpeg_args("ffmpeg.exe", "../../bad", 8554)
        with self.assertRaises(ValueError):
            validate_camera(connected_camera("../bad"), "slot-1")
        with self.assertRaises(RuntimeError):
            validate_camera({"cameras": []}, "slot-1")
        without_audio = connected_camera()
        without_audio["cameras"][0]["audio"]["connected"] = False
        with self.assertRaises(RuntimeError):
            validate_camera(without_audio, "slot-1")

    def test_bridge_transport_is_local_and_opt_in(self):
        request = make_bridge_request("http://127.0.0.1:5000", "slot-1")
        self.assertEqual(
            request.full_url,
            "http://127.0.0.1:5000/cameras/slot-1/experimental-neural-pcm",
        )
        self.assertEqual(request.get_header("X-msds-shadow-client"), "neural-kws-trial")
        with self.assertRaises(ValueError):
            make_bridge_request("http://127.0.0.1:5000", "../../credentials")
        status = connected_camera()
        self.assertFalse(pcm_bridge_enabled(status, "slot-1"))
        status["cameras"][0]["audio"]["neural_shadow_pcm"] = {"enabled": True}
        self.assertTrue(pcm_bridge_enabled(status, "slot-1"))
        self.assertFalse(pcm_bridge_enabled(status, "slot-2"))
        with patch.dict(os.environ, {"MSDS_KWS_SHADOW_PCM": "1"}):
            self.assertTrue(pcm_enabled())
        with patch.dict(os.environ, {"MSDS_KWS_SHADOW_PCM": "0"}):
            self.assertFalse(pcm_enabled())

    def test_shadow_audio_tap_never_blocks_dtw_and_rejects_overflow(self):
        feed = ShadowPCMFeed(queue_size=1)
        self.assertFalse(feed.has_subscriber())
        subscriber = feed.subscribe()
        self.assertIsNotNone(subscriber)
        self.assertIsNone(feed.subscribe())  # Only one local observer.
        feed.publish(b"\x00\x00" * 160)
        self.assertEqual(subscriber.get_nowait(), b"\x00\x00" * 160)
        feed.publish(b"\x01\x00" * 160)
        # Publishing a second packet without consuming the first disconnects
        # instead of injecting noncontiguous audio into the neural stream.
        feed.publish(b"\x02\x00" * 160)
        self.assertFalse(feed.has_subscriber())
        self.assertEqual(subscriber.get_nowait(), b"\x01\x00" * 160)
        with self.assertRaises(queue.Empty):
            subscriber.get_nowait()
        feed.unsubscribe(subscriber)
        replacement = feed.subscribe()
        self.assertIsNotNone(replacement)
        feed.disconnect()
        self.assertFalse(feed.has_subscriber())

    def test_backend_pcm_endpoint_denies_lan_and_browser_origins(self):
        try:
            import fastapi  # noqa: F401
        except ImportError:
            self.skipTest("FastAPI is optional in the minimal shadow-only test workflow")
        from fastapi import HTTPException
        from starlette.requests import Request
        from msds.api import experimental_neural_pcm
        def request(host: str, origin: str | None = None, client: str = "neural-kws-trial"):
            hs = [(b"x-msds-shadow-client", client.encode("ascii"))]
            if origin is not None:
                hs.append((b"origin", origin.encode("ascii")))
            return Request({"type": "http", "method": "GET", "path": "/",
                            "headers": hs, "client": (host, 12345),
                            "server": ("127.0.0.1", 5000), "scheme": "http"})
        with patch.dict(os.environ, {"MSDS_KWS_SHADOW_PCM": "0"}):
            with self.assertRaises(HTTPException) as err:
                experimental_neural_pcm("slot-1", request("127.0.0.1"))
            self.assertEqual(err.exception.status_code, 404)
        with patch.dict(os.environ, {"MSDS_KWS_SHADOW_PCM": "1"}):
            for host, origin, client in [
                ("192.168.0.12", None, "neural-kws-trial"),
                ("127.0.0.1", "http://localhost:8080", "neural-kws-trial"),
                ("127.0.0.1", None, "browser"),
            ]:
                with self.assertRaises(HTTPException) as err:
                    experimental_neural_pcm("slot-1", request(host, origin, client))
                self.assertEqual(err.exception.status_code, 403)

    def test_neural_result_cannot_change_dtw_status(self):
        state = connected_camera()
        before = state["cameras"][0]["audio"]["custom_kws"].copy()
        snap = dtw_snapshot(state, "slot-1")
        self.assertEqual(snap["candidate"], "help")
        self.assertEqual(snap["decision"], "duration_mismatch")
        self.assertEqual(state["cameras"][0]["audio"]["custom_kws"], before)

    def test_safe_archive_rejects_path_traversal_and_links(self):
        with tarfile.open(fileobj=io.BytesIO(), mode="w") as tar:
            member = tarfile.TarInfo(MODEL_NAME + "/tokens.txt")
            data = b"token 1"
            member.size = len(data)
            tar.addfile(member, io.BytesIO(data))
            self.assertEqual(len(safe_members(tar)), 1)
        for invalid in ("../evil.txt", "/absolute", MODEL_NAME + "/../../outside"):
            with tarfile.open(fileobj=io.BytesIO(), mode="w") as tar:
                m = tarfile.TarInfo(invalid)
                m.size = 0
                tar.addfile(m, io.BytesIO(b""))
                with self.assertRaises(ValueError):
                    safe_members(tar)
        with tarfile.open(fileobj=io.BytesIO(), mode="w") as tar:
            m = tarfile.TarInfo(MODEL_NAME + "/link")
            m.type = tarfile.SYMTYPE
            m.linkname = "targets"
            tar.addfile(m)
            with self.assertRaises(ValueError):
                safe_members(tar)


if __name__ == "__main__":
    unittest.main()
