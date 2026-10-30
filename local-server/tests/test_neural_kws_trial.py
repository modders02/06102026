"""Read-only neural KWS test suite; no model, audio or FFmpeg required."""
from __future__ import annotations
import io
from pathlib import Path
import sys
import tarfile
import unittest

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
from neural_kws_trial import (  # noqa: E402
    CHUNK_BYTES, dtw_snapshot, make_ffmpeg_args, normalize_word,
    validate_camera,
)
from prepare_neural_kws import MODEL_NAME, safe_members, KEYWORDS  # noqa: E402


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
        self.assertRegex(requirements, r"(?m)^click(?:[<=>!~].*)?$")
        setup = (HERE / "setup_neural_kws_windows.cmd").read_text(encoding="utf-8")
        self.assertIn("sherpa-onnx-cli.exe", setup)
        self.assertIn("text2token --help", setup)
        self.assertIn("import click, sentencepiece, sherpa_onnx", setup)
        self.assertIn('set "PYTHONIOENCODING=utf-8"', setup)
        self.assertIn('set "PYTHONUTF8=1"', setup)
        prepare = (HERE / "prepare_neural_kws.py").read_text(encoding="utf-8")
        self.assertIn('env["PYTHONIOENCODING"] = "utf-8"', prepare)
        self.assertIn('"--tokens-type", "bpe"', prepare)

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
