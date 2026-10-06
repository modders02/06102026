"""Packaged runtime regression checks; no external process is started."""
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from msds import manager


class RuntimeTests(unittest.TestCase):
    def test_mediamtx_generates_files_in_writable_runtime(self):
        runtime = str(Path("user-data") / "camera-runtime")
        executable = str(Path("Program Files") / "MSDS" / "bin" / "mediamtx.exe")
        with patch.object(manager, "MEDIAMTX", None), \
                patch.dict(os.environ, {"MSDS_RUNTIME_DIR": runtime}), \
                patch.object(manager, "resolve_exe", return_value=executable), \
                patch.object(manager.time, "sleep"), \
                patch.object(manager.subprocess, "Popen", return_value=Mock()) as spawn:
            manager.start_mediamtx()
            self.assertEqual(spawn.call_args.kwargs["cwd"], runtime)
            self.assertEqual(spawn.call_args.args[0][0], executable)


if __name__ == "__main__":
    unittest.main()
