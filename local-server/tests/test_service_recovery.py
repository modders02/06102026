"""Service ownership and startup tests. No system process is terminated."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from msds import service_recovery as recovery


class ServiceRecoveryTests(unittest.TestCase):
    def test_correct_orphan_is_reclaimed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            exe = str(root / "bin" / "mediamtx.exe")
            cfg = str(root / "mediamtx.yml")
            Path(cfg).write_text("rtsp: yes")
            before = {8554: {123}, 8888: {123}}
            after = {}
            proc = MagicMock()
            proc.pid = 123
            proc.exe.return_value = exe
            proc.cmdline.return_value = [exe, cfg]
            proc.parent.return_value = None
            proc.wait.return_value = 0

            with patch.object(recovery, "_listeners", side_effect=[before, after]), \
                 patch.object(recovery.psutil, "Process", return_value=proc):
                result = recovery.recover_media_ports(exe, cfg)
            self.assertEqual(result.reclaimed, (123,))
            self.assertEqual(result.blockers, ())
            proc.terminate.assert_called_once()
            proc.kill.assert_not_called()

    def test_live_owner_must_not_be_killed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            exe = str(root / "mediamtx.exe")
            cfg = str(root / "mediamtx.yml")
            Path(cfg).write_text("rtsp: yes")
            proc = MagicMock()
            proc.exe.return_value = exe
            proc.cmdline.return_value = [exe, cfg]
            proc.parent.return_value = SimpleNamespace(pid=2000)
            with patch.object(recovery, "_listeners", return_value={8554: {123}}), \
                 patch.object(recovery.psutil, "Process", return_value=proc):
                result = recovery.recover_media_ports(exe, cfg)
            self.assertEqual(result.reclaimed, ())
            self.assertIn("port 8554 (PID 123)", result.blockers)
            proc.terminate.assert_not_called()
            proc.kill.assert_not_called()

    def test_foreign_process_or_mismatched_config_is_never_killed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            exe = str(root / "bin" / "mediamtx.exe")
            cfg = str(root / "mediamtx.yml")
            Path(cfg).write_text("rtsp: yes")
            for process_exe, args in (
                (str(root / "other" / "mediamtx.exe"), [str(root / "other" / "mediamtx.exe"), cfg]),
                (exe, [exe, str(root / "different.yml")]),
                (exe, [exe, cfg, "--some-other-mode"]),
            ):
                with self.subTest(process_exe=process_exe, args=args):
                    proc = MagicMock()
                    proc.exe.return_value = process_exe
                    proc.cmdline.return_value = args
                    proc.parent.return_value = None
                    with patch.object(recovery, "_listeners", return_value={8554: {321}}), \
                         patch.object(recovery.psutil, "Process", return_value=proc):
                        result = recovery.recover_media_ports(exe, cfg)
                    self.assertEqual(result.reclaimed, ())
                    self.assertTrue(result.blockers)
                    proc.terminate.assert_not_called()

    def test_unidentified_listener_blocks_instead_of_killing(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            cfg = str(root / "mediamtx.yml")
            Path(cfg).write_text("rtsp: yes")
            with patch.object(recovery, "_listeners", return_value={8554: {None}}), \
                 patch.object(recovery.psutil, "Process") as process:
                outcome = recovery.recover_media_ports("mediamtx.exe", cfg)
            self.assertEqual(outcome.reclaimed, ())
            self.assertIn("port 8554 (PID unknown)", outcome.blockers)
            process.assert_not_called()

    def test_port_listeners_are_filtered_and_grouped(self):
        conn = lambda port, pid, state="LISTEN": SimpleNamespace(
            status=state, laddr=SimpleNamespace(port=port), pid=pid,
        )
        with patch.object(recovery.psutil, "net_connections", return_value=[
            conn(8554, 100), conn(8554, 100), conn(8888, 100), conn(5432, 900),
            conn(8554, 200, "ESTABLISHED"),
        ]):
            self.assertEqual(recovery._listeners({8554, 8888}),
                             {8554: {100}, 8888: {100}})

    def test_api_port_check_preserves_other_services(self):
        with patch.object(recovery, "_listeners", return_value={5000: {456}}):
            self.assertTrue(recovery.api_port_in_use(5000))
        with patch.object(recovery, "_listeners", return_value={}):
            self.assertFalse(recovery.api_port_in_use(5000))


if __name__ == "__main__":
    unittest.main()
