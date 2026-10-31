"""Regression tests for isolated training/augmentation and WAV capture.

No camera, pretrained model, enrollment data or external network is required.
"""
from __future__ import annotations

import io
from urllib.error import HTTPError
from pathlib import Path
import tempfile
import unittest
import wave
import sys

import numpy as np

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
from capture_noise_kws_wavs import capture_wav, capture_one_take, destination
from train_noise_augmented_kws import (
    ACCEPT_THRESHOLD, DIM, LABELS, SAMPLE_RATE, augment_audio, check_disjoint,
    encode_dataset, evaluate_holdout, feature_vector, infer_probs, inventory,
    load_model, noise_window, predict_one, read_audio, save_model, train_mlp,
    audit_dataset, build_variant,
)
from msds.kws_engine import CustomKeywordEngine
from msds.neural_shadow_pcm import ShadowPCMFeed, PCMGapError, collect_pcm_take


def write_wav(path: Path, samples: np.ndarray, rate: int = SAMPLE_RATE):
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as file:
        file.setnchannels(1)
        file.setsampwidth(2)
        file.setframerate(rate)
        file.writeframes((np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes())


class NoiseAugmentedKWSTests(unittest.TestCase):
    def test_dataset_inventory_requires_unknown_and_disjoint_holdout(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            summary = inventory(root)
            self.assertFalse(summary["ready"])
            self.assertEqual(summary["required_noise"], 3)
            a = root / "train" / "help" / "same.wav"
            b = root / "holdout" / "help" / "same.wav"
            a.parent.mkdir(parents=True)
            b.parent.mkdir(parents=True)
            a.write_bytes(b"same wav data")
            b.write_bytes(b"same wav data")
            with self.assertRaisesRegex(ValueError, "Duplicate WAV"):
                check_disjoint({"help": [a]}, {"help": [b]}, [])

    def test_audio_audit_identifies_short_transient_by_actual_filename(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            engine = CustomKeywordEngine(data_dir=str(root / "unused-feature-directory"))
            bad = np.zeros(int(1.8 * SAMPLE_RATE), dtype=np.float32)
            tone = np.arange(640, dtype=np.float32) / SAMPLE_RATE
            bad[7000:7640] = 0.35 * np.sin(2 * np.pi * 400 * tone)
            path = root / "train" / "help" / "only-short-click.wav"
            write_wav(path, bad)
            outcome = audit_dataset(root, engine)
            self.assertFalse(outcome["passed"])
            self.assertEqual(outcome["recordings_scanned"], 1)
            self.assertIn("train/help/only-short-click.wav", outcome["issues"][0]["file"])
            self.assertIn("No valid speech features detected", outcome["issues"][0]["reason"])
            self.assertTrue(path.is_file())  # Audit never deletes raw audio.

    def test_invalid_synthetic_window_retries_not_real_wavs(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as tmp:
            engine = CustomKeywordEngine(data_dir=str(Path(tmp) / "feature-only"))
            # Actual noise WAV may have a single brief loud transient. One
            # randomly selected window is not representative of the whole file.
            one_second = np.full(SAMPLE_RATE, 0.02, dtype=np.float32)
            with patch("train_noise_augmented_kws.feature_vector", side_effect=[
                ValueError("No valid speech features detected (log-Mel frames=6)"),
                np.ones(DIM, dtype=np.float32),
            ]) as mock_features:
                vector, retries = build_variant(
                    one_second, [], np.random.default_rng(5), engine,
                    "noise/fan.wav negative crop", background=True,
                )
            self.assertEqual(retries, 1)
            self.assertEqual(mock_features.call_count, 2)
            self.assertEqual(vector.shape, (DIM,))
            with patch("train_noise_augmented_kws.feature_vector",
                       side_effect=ValueError("No valid speech features detected")):
                with self.assertRaisesRegex(ValueError, "noise/impact.wav"):
                    build_variant(one_second, [], np.random.default_rng(5), engine,
                                  "noise/impact.wav", background=True, max_attempts=2)

    def test_augmentation_is_reproducible_and_does_not_modify_original(self):
        sr = SAMPLE_RATE
        t = np.arange(sr, dtype=np.float32) / sr
        clean = (0.1 * np.sin(2 * np.pi * 390 * t)).astype(np.float32)
        noise = (0.1 * np.sin(2 * np.pi * 70 * t)).astype(np.float32)
        original = clean.copy()
        out1 = augment_audio(clean, [noise], np.random.default_rng(23),
                             snr_db=5, force_noise=True)
        out2 = augment_audio(clean, [noise], np.random.default_rng(23),
                             snr_db=5, force_noise=True)
        np.testing.assert_allclose(out1, out2)
        np.testing.assert_array_equal(clean, original)
        self.assertFalse(np.array_equal(out1, clean))
        self.assertEqual(out1.shape, clean.shape)
        self.assertLessEqual(float(np.max(np.abs(out1))), 1)
        self.assertEqual(len(noise_window(noise[:500], 1600, np.random.default_rng(3))), 1600)
        with self.assertRaises(ValueError):
            augment_audio(clean, [], np.random.default_rng(2), force_noise=True)

    def test_feature_extractor_mlps_and_numpy_only_model(self):
        t = np.arange(12000, dtype=np.float32) / SAMPLE_RATE
        signal = (0.15 * np.sin(2 * np.pi * 350 * t)).astype(np.float32)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            extractor = CustomKeywordEngine(data_dir=str(root / "not-active-templates"))
            vec = feature_vector(signal, extractor)
            self.assertEqual(vec.shape, (DIM,))
            self.assertTrue(np.isfinite(vec).all())
            wav = root / "test.wav"
            write_wav(wav, signal)
            self.assertEqual(len(read_audio(wav, extractor)), len(signal))
            with self.assertRaises(ValueError):
                read_audio(root / "missing.wav", extractor)

            rng = np.random.default_rng(44)
            x = rng.normal(size=(48, DIM)).astype(np.float32)
            y = np.tile(np.arange(len(LABELS)), 6)
            w = train_mlp(x, y, epochs=2, seed=44)
            prob = infer_probs(x, w)
            self.assertEqual(prob.shape, (48, len(LABELS)))
            np.testing.assert_allclose(prob.sum(axis=1), 1, atol=1e-5)
            predicted, conf, margin = predict_one(x[0], w)
            self.assertIn(predicted, LABELS)
            self.assertTrue(0 <= conf <= 1)
            self.assertTrue(0 <= margin <= 1)
            outcome = evaluate_holdout(x, y, w)
            self.assertIn("unknown_false_positive_rate", outcome)
            model = root / "artifacts" / "candidate.npz"
            from train_noise_augmented_kws import MODEL_VERSION
            save_model(model, w, {"version": MODEL_VERSION, "labels": LABELS})
            loaded, metadata = load_model(model)
            self.assertEqual(tuple(metadata["labels"]), LABELS)
            np.testing.assert_allclose(infer_probs(x, loaded), prob, atol=1e-6)
            self.assertFalse((root / "not-active-templates").exists()
                             and list((root / "not-active-templates").glob("*.npy")))

    def test_atomic_pcm_take_owns_subscription_and_detects_gaps(self):
        feed = ShadowPCMFeed(queue_size=2)
        subscriber = feed.subscribe()
        feed.publish(b"\x01\x00" * 400)
        pcm = collect_pcm_take(feed, subscriber, 800, lambda: True)
        self.assertEqual(pcm, b"\x01\x00" * 400)
        feed.unsubscribe(subscriber)
        self.assertFalse(feed.has_subscriber())

        # If the camera drops audio after a partial packet, do not
        # combine two unrelated recording sessions into one training WAV.
        subscriber = feed.subscribe()
        feed.publish(b"\x01\x00" * 100)
        feed.publish(b"\x02\x00" * 100)
        feed.publish(b"\x03\x00" * 100)  # Overflow disconnects subscriber.
        self.assertFalse(feed.has_subscriber())
        with self.assertRaisesRegex(PCMGapError, "overflowed"):
            collect_pcm_take(feed, subscriber, 400, lambda: True)
        feed.unsubscribe(subscriber)

    def test_repeated_atomic_capture_and_conflict_retries(self):
        samples = (np.sin(np.linspace(0, 30 * np.pi, SAMPLE_RATE, dtype=np.float32))
                   * 0.25).astype(np.float32)
        pcm = (samples * 32767).astype("<i2").tobytes()
        request_urls = []
        pending_conflicts = [0]

        class CaptureStream(io.BytesIO):
            def __init__(self, body):
                super().__init__(body)
                self.headers = {
                    "X-MSDS-PCM-Format": "s16le-16000-mono",
                    "X-MSDS-Capture": "complete",
                }

        def opener(request, timeout):
            request_urls.append(request.full_url)
            self.assertEqual(request.get_method(), "GET")
            self.assertTrue(request.full_url.endswith("/take?seconds=1"))
            if pending_conflicts[0]:
                pending_conflicts[0] -= 1
                raise HTTPError(request.full_url, 409, "in use", None, None)
            return CaptureStream(pcm)

        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "train" / "help"
            for _ in range(3):
                path, count, digest = capture_one_take(
                    "http://127.0.0.1:5000", "slot-1", dest, 1.0,
                    opener=opener, sleep=lambda _: None,
                )
                self.assertTrue(path.is_file())
                self.assertEqual(count, SAMPLE_RATE * 2)
                self.assertEqual(len(digest), 64)
            self.assertEqual(len(list(dest.glob("*.wav"))), 3)
            pending_conflicts[0] = 1
            waits = []
            path, count, _ = capture_one_take(
                "http://127.0.0.1:5000", "slot-1", dest, 1.0,
                opener=opener, sleep=waits.append,
            )
            self.assertEqual(waits, [0.5])
            self.assertEqual(count, SAMPLE_RATE * 2)
            self.assertTrue(path.exists())
            self.assertEqual(len(list(dest.glob("*.wav"))), 4)
            self.assertEqual(len(request_urls), 5)

    def test_incomplete_atomic_response_or_503_never_saves_wav(self):
        samples = b"\x01\x00" * SAMPLE_RATE

        class CaptureStream(io.BytesIO):
            def __init__(self, body):
                super().__init__(body)
                self.headers = {
                    "X-MSDS-PCM-Format": "s16le-16000-mono",
                    "X-MSDS-Capture": "complete",
                }

        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp) / "holdout" / "help"
            with self.assertRaisesRegex(RuntimeError, "Incomplete PCM response"):
                capture_one_take(
                    "http://127.0.0.1:5000", "slot-1", folder, 1.0,
                    opener=lambda req, timeout: CaptureStream(samples[:3000]),
                )
            self.assertFalse(folder.exists())
            def fail_503(req, timeout):
                raise HTTPError(req.full_url, 503, "PCM stalled", None, None)
            with self.assertRaises(HTTPError) as ctx:
                capture_one_take("http://127.0.0.1:5000", "slot-1",
                                 folder, 1.0, opener=fail_503)
            self.assertEqual(ctx.exception.code, 503)
            self.assertFalse(folder.exists())

    def test_atomic_backend_route_cleans_up_and_blocks_nonlocal_clients(self):
        try:
            from fastapi import HTTPException
            from starlette.requests import Request
            from msds.api import experimental_neural_pcm_take
            from msds.manager import CAMERAS
        except ImportError:
            self.skipTest("Full FastAPI backend required for endpoint test")
        from unittest.mock import patch
        import os
        import threading
        from types import SimpleNamespace

        feed = ShadowPCMFeed(queue_size=4)
        camera = SimpleNamespace(
            id="slot-1", enabled=True, stop_flag=threading.Event(),
            audio_connected=True,
            audio_thread=SimpleNamespace(is_alive=lambda: True),
            neural_shadow_pcm=feed,
        )

        def request(host="127.0.0.1", origin=None):
            headers = [(b"x-msds-shadow-client", b"neural-kws-trial")]
            if origin:
                headers.append((b"origin", origin.encode("utf-8")))
            return Request({
                "type": "http", "method": "GET", "path": "/",
                "headers": headers, "client": (host, 5555),
                "server": ("127.0.0.1", 5000), "scheme": "http",
            })

        with patch.dict(os.environ, {"MSDS_KWS_SHADOW_PCM": "1"}):
            with patch.dict(CAMERAS, {"slot-1": camera}):
                for host, origin in [("192.168.0.3", None),
                                     ("127.0.0.1", "http://localhost:8080")]:
                    with self.assertRaises(HTTPException) as err:
                        experimental_neural_pcm_take("slot-1", request(host, origin),
                                                     seconds=0.5)
                    self.assertEqual(err.exception.status_code, 403)
                with self.assertRaises(HTTPException) as err:
                    experimental_neural_pcm_take("slot-1", request(), seconds=100)
                self.assertEqual(err.exception.status_code, 422)

                def publish_pcm():
                    # The route acquires the subscriber before its blocking
                    # read. A short producer thread simulates existing DTW PCM.
                    import time
                    until = time.monotonic() + 1.0
                    while not feed.has_subscriber() and time.monotonic() < until:
                        time.sleep(0.001)
                    feed.publish(b"\x04\x00" * 8000)

                thread = threading.Thread(target=publish_pcm, daemon=True)
                thread.start()
                response = experimental_neural_pcm_take(
                    "slot-1", request(), seconds=0.5,
                )
                thread.join(timeout=2)
                self.assertEqual(len(response.body), 16000)
                self.assertEqual(response.headers["x-msds-capture"], "complete")
                self.assertFalse(feed.has_subscriber())

    def test_pcm_lease_isolation_and_explicit_release(self):
        feed = ShadowPCMFeed(queue_size=2)
        a = feed.subscribe()
        first_token = feed.lease_for(a)
        self.assertTrue(first_token)
        self.assertTrue(feed.is_current(a))
        self.assertFalse(feed.release_lease("wrong-token"))
        self.assertTrue(feed.is_current(a))
        self.assertTrue(feed.release_lease(first_token))
        self.assertFalse(feed.has_subscriber())
        b = feed.subscribe()
        self.assertTrue(feed.is_current(b))
        self.assertFalse(feed.is_current(a))
        self.assertFalse(feed.release_lease(first_token))
        self.assertTrue(feed.has_subscriber())
        feed.unsubscribe(a)  # Old async generator cleanup cannot evict B.
        self.assertTrue(feed.is_current(b))
        self.assertTrue(feed.release_lease(feed.lease_for(b)))
        self.assertFalse(feed.has_subscriber())

    def test_local_capture_writes_only_explicit_split_and_valid_wav(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.assertEqual(destination(root, "help", "holdout"),
                             root / "holdout" / "help")
            self.assertEqual(destination(root, "noise", "train"), root / "noise")
            with self.assertRaises(ValueError):
                destination(root, "../help", "train")
            samples = (np.sin(np.linspace(0, 40 * np.pi, SAMPLE_RATE, dtype=np.float32))
                       * 0.25).astype(np.float32)
            pcm = (samples * 32767).astype("<i2").tobytes()
            dst = root / "holdout" / "help" / "capture.wav"
            n, digest = capture_wav(io.BytesIO(pcm), dst, 1.0)
            self.assertEqual(n, len(pcm))
            self.assertEqual(len(digest), 64)
            with wave.open(str(dst), "rb") as file:
                self.assertEqual(file.getframerate(), SAMPLE_RATE)
                self.assertEqual(file.getnframes(), SAMPLE_RATE)
            with self.assertRaises(FileExistsError):
                capture_wav(io.BytesIO(pcm), dst, 1.0)
            with self.assertRaises(ValueError):
                capture_wav(io.BytesIO(b"\x00\x00" * SAMPLE_RATE), root / "silent.wav", 1.0)
            self.assertFalse((root / "silent.wav").exists())


if __name__ == "__main__":
    unittest.main()
