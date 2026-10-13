"""Test old-style terminal enrollment without CCTV hardware or live model writes."""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import enroll_english_kws as enrollment  # noqa: E402


class FakeEnrollmentClient:
    def __init__(self, template_dir: Path, count: int = 0):
        self.camera = "slot-1"
        self.template_dir = template_dir
        self.count = count
        self.armed = False
        self.started = 0
        self.cancelled = 0
        self.missing_media = False

    def camera_status(self):
        if self.missing_media:
            raise enrollment.EnrollmentError("MediaMTX is not running")
        return {"cameras": [{"id": self.camera}]}

    def kws_status(self):
        return {"data_dir": str(self.template_dir),
                "keywords": {"help": self.count}}

    def start(self, keyword):
        self.started += 1
        self.armed = True
        return {"state": "waiting", "keyword": keyword}

    def state(self):
        if not self.armed:
            return {"state": "waiting"}
        self.count += 1
        self.armed = False
        return {"state": "captured", "keyword": "help", "templates": self.count}

    def cancel(self):
        self.cancelled += 1


class InteractiveEnrollmentTests(unittest.TestCase):
    def test_repeated_enter_captures_one_sample_per_prompt(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "templates" / "help").mkdir(parents=True)
            original = root / "templates" / "help" / "older.npy"
            original.write_bytes(b"old acoustic template")
            client = FakeEnrollmentClient(root / "templates")
            messages = []
            inputs = iter(["", "", ""])
            with patch.object(enrollment, "HERE", root):
                count = enrollment.do_enrollment(
                    client, "help", 3,
                    input_fn=lambda _: next(inputs),
                    out=messages.append,
                )
            self.assertEqual(count, 3)
            self.assertEqual(client.started, 3)
            self.assertEqual(client.count, 3)
            self.assertEqual(original.read_bytes(), b"old acoustic template")
            self.assertEqual(len(list((root / "kws-backups").glob("*.zip"))), 1)
            self.assertTrue(any("SAVED" in line for line in messages))

    def test_quit_before_start_preserves_templates(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "templates").mkdir()
            client = FakeEnrollmentClient(root / "templates")
            with patch.object(enrollment, "HERE", root):
                count = enrollment.do_enrollment(client, "help", 3,
                                                 input_fn=lambda _: "q",
                                                 out=lambda _: None)
            self.assertEqual(count, 0)
            self.assertEqual(client.started, 0)

    def test_capacity_guard_prevents_replacing_oldest(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "templates").mkdir()
            client = FakeEnrollmentClient(root / "templates", count=enrollment.MAX_TEMPLATES)
            with patch.object(enrollment, "HERE", root):
                with self.assertRaisesRegex(enrollment.EnrollmentError, "refusing to delete"):
                    enrollment.do_enrollment(client, "help", 1,
                                             input_fn=lambda _: "",
                                             out=lambda _: None)
            self.assertEqual(client.started, 0)

    def test_abort_on_missing_camera_audio(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "templates").mkdir()
            client = FakeEnrollmentClient(root / "templates")
            client.missing_media = True
            with self.assertRaisesRegex(enrollment.EnrollmentError, "MediaMTX"):
                enrollment.do_enrollment(client, "help", 1, out=lambda _: None)
            self.assertEqual(client.started, 0)

    def test_wait_detects_capture_error_and_cancel(self):
        with tempfile.TemporaryDirectory() as folder:
            client = FakeEnrollmentClient(Path(folder))
            client.state = lambda: {"state": "error", "keyword": "help",
                                    "message": "No valid speech"}
            with self.assertRaisesRegex(enrollment.EnrollmentError, "No valid speech"):
                enrollment.wait_for_capture(client, "help", 0, timeout=1)

    def test_only_local_host_is_used(self):
        client = enrollment.EnrollmentClient("slot-1", port=5000)
        self.assertEqual(client.base, "http://127.0.0.1:5000")


if __name__ == "__main__":
    unittest.main()
