"""GH metadata requests use the Actions token without leaking to download hosts."""
from __future__ import annotations

import io
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import fetch_binaries


class BinaryDownloaderAuthorizationTests(unittest.TestCase):
    def test_gh_api_token_applies_only_to_api_host(self):
        token = "fake-short-lived-actions-token"
        with patch.dict(os.environ, {"GITHUB_TOKEN": token}, clear=False):
            for url, permitted in [
                ("https://api.github.com/repos/bluenviron/mediamtx/releases/latest", True),
                ("https://github.com/bluenviron/mediamtx/releases/download/v1.0/file.zip", False),
                ("https://example.com/file.zip", False),
            ]:
                with self.subTest(url=url):
                    with patch("fetch_binaries.urllib.request.urlopen", return_value=io.BytesIO(b"abc")) as call:
                        self.assertEqual(fetch_binaries.download(url), b"abc")
                    request = call.call_args.args[0]
                    self.assertEqual(request.get_header("Authorization"), f"Bearer {token}" if permitted else None)

    def test_no_token_is_needed_for_public_api_requests(self):
        with patch.dict(os.environ, {"GITHUB_TOKEN": "", "GH_TOKEN": ""}):
            with patch("fetch_binaries.urllib.request.urlopen", return_value=io.BytesIO(b"{}")) as call:
                fetch_binaries.download(fetch_binaries.MEDIAMTX_RELEASE_API)
            self.assertIsNone(call.call_args.args[0].get_header("Authorization"))


if __name__ == "__main__":
    unittest.main()
