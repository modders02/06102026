"""Sidecar contract tests run without TensorFlow/FER being installed."""
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from fer_emotion_service import sanitize_predictions  # noqa: E402


class FerSidecarTests(unittest.TestCase):
    def test_largest_detected_face(self):
        data = [
            {"box": [0, 0, 15, 15], "emotions": {"happy": 1.0}},
            {"box": [0, 0, 150, 150], "emotions": {
                "angry": 0.05, "disgust": 0.01, "fear": 0.03,
                "happy": 0.04, "sad": 0.1, "surprise": 0.75, "neutral": 0.02,
            }},
        ]
        result = sanitize_predictions(data)
        self.assertEqual(result["label"], "surprise")
        self.assertEqual(result["confidence"], 0.75)

    def test_accepts_numpy_float32_scores(self):
        import numpy as np
        payload = {"box": [0, 0, 120, 120],
                   "emotions": {"happy": np.float32(0.9), "neutral": np.float32(0.1)}}
        self.assertEqual(sanitize_predictions([payload])["label"], "happy")

    def test_rejects_invalid_results(self):
        self.assertIsNone(sanitize_predictions([]))
        self.assertIsNone(sanitize_predictions([{"box": [0, 0, 5, 5], "emotions": {}}]))
        self.assertIsNone(sanitize_predictions([{"box": [0, 0, 100, 100], "emotions": {"happy": float("nan")}}]))


if __name__ == "__main__":
    unittest.main()
