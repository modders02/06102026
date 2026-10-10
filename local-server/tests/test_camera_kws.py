"""Camera integration tests for the custom MSDS keyword engine."""
from pathlib import Path
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from msds.camera import Camera
from msds.kws_engine import KWS_ENGINE


class CameraCustomKeywordTests(unittest.TestCase):
    def make_camera(self):
        return Camera(
            id="slot-1",
            path="cam1",
            name="Camera 1",
            rtsp="rtsp://example",
        )

    def test_custom_keyword_event_updates_live_transcript_once(self):
        cam = self.make_camera()
        segment = b"\x01\x00" * 12000
        match = SimpleNamespace(
            keyword="help",
            confidence=0.91,
            distance=0.09,
            runner_up_keyword="fire",
            runner_up_confidence=0.2,
            keyword_scores={"help": 0.91, "fire": 0.2},
            keyword_duration_ratios={"help": 1.0, "fire": 0.8},
            class_margin=0.71,
            required_margin=0.02,
            negative_confidence=0.1,
            negative_second_confidence=0.08,
            negative_mean2_confidence=0.09,
            negative_top_confidences=[0.1, 0.08, 0.05],
            duration_ratio=1.0,
            duration_ms=750,
            accepted=True,
            reason="accepted",
        )

        with patch.object(KWS_ENGINE, "has_ready_templates", return_value=True), \
                patch.object(cam.kws_segmenter, "feed", return_value=[segment]), \
                patch.object(KWS_ENGINE, "diagnose", return_value=match):
            cam._process_custom_kws_pcm(b"pcm")

        self.assertEqual(len(cam.events), 1)
        self.assertEqual(cam.events[0]["source"], "custom-kws")
        self.assertEqual(cam.events[0]["keyword"], "help")
        self.assertEqual(cam.events[0]["transcript"], "help")
        self.assertEqual(cam.last_transcript, "help")
        self.assertEqual(cam.kws_last_keyword, "help")
        self.assertEqual(cam.kws_last_candidate, "help")
        self.assertEqual(cam.kws_last_runner_up_keyword, "fire")
        self.assertEqual(cam.kws_last_keyword_scores["help"], 0.91)
        self.assertEqual(cam.kws_last_keyword_duration_ratios["help"], 1.0)
        self.assertEqual(cam.kws_last_class_margin, 0.71)
        self.assertEqual(cam.kws_last_required_margin, 0.02)
        self.assertEqual(cam.kws_last_negative_second_confidence, 0.08)
        self.assertEqual(cam.kws_last_negative_mean2_confidence, 0.09)
        self.assertEqual(cam.kws_last_negative_top_confidences, [0.1, 0.08, 0.05])
        self.assertEqual(cam.kws_last_decision, "accepted")
        self.assertEqual(cam.kws_segments_seen, 1)
        self.assertGreaterEqual(cam.events[0]["processing_ms"], 0)

        # An accidental duplicate callback inside the short guard is suppressed.
        with patch("msds.camera.time.time", return_value=cam._last_kws_publish_ts + 0.1), \
                patch.object(KWS_ENGINE, "has_ready_templates", return_value=True), \
                patch.object(cam.kws_segmenter, "feed", return_value=[segment]), \
                patch.object(KWS_ENGINE, "diagnose", return_value=match):
            cam._process_custom_kws_pcm(b"pcm")
        self.assertEqual(len(cam.events), 1)

        # A separately completed repeat is a new valid trigger and must publish.
        with patch("msds.camera.time.time", return_value=cam._last_kws_publish_ts + 0.6), \
                patch.object(KWS_ENGINE, "has_ready_templates", return_value=True), \
                patch.object(cam.kws_segmenter, "feed", return_value=[segment]), \
                patch.object(KWS_ENGINE, "diagnose", return_value=match):
            cam._process_custom_kws_pcm(b"pcm")
        self.assertEqual(len(cam.events), 2)

    def test_rejected_candidate_is_visible_in_diagnostics(self):
        cam = self.make_camera()
        segment = b"\x01\x00" * 12000
        decision = SimpleNamespace(
            keyword="help",
            confidence=0.61,
            distance=0.39,
            runner_up_keyword="",
            runner_up_confidence=0.0,
            keyword_scores={"help": 0.61},
            keyword_duration_ratios={"help": 1.0},
            class_margin=0.61,
            required_margin=0.04,
            negative_confidence=0.2,
            negative_second_confidence=0.15,
            negative_mean2_confidence=0.175,
            negative_top_confidences=[0.2, 0.15, 0.1],
            duration_ratio=1.0,
            duration_ms=750,
            accepted=False,
            reason="below_threshold",
        )

        with patch.object(KWS_ENGINE, "has_ready_templates", return_value=True), \
                patch.object(cam.kws_segmenter, "feed", return_value=[segment]), \
                patch.object(KWS_ENGINE, "diagnose", return_value=decision):
            cam._process_custom_kws_pcm(b"pcm")

        self.assertEqual(cam.events, [])
        self.assertEqual(cam.kws_segments_seen, 1)
        self.assertEqual(cam.kws_last_candidate, "help")
        self.assertEqual(cam.kws_last_candidate_confidence, 0.61)
        self.assertEqual(cam.kws_last_negative_confidence, 0.2)
        self.assertEqual(cam.kws_last_duration_ratio, 1.0)
        self.assertEqual(cam.kws_last_decision, "below_threshold")
        self.assertEqual(cam.kws_last_keyword, "")

    def test_unknown_enrollment_uses_non_keyword_prompt(self):
        cam = self.make_camera()
        result = cam.request_kws_enrollment("unknown")
        self.assertEqual(result["keyword"], "unknown")
        self.assertIn("NON-keyword", result["message"])

    def test_enrollment_captures_template_without_publishing_alert(self):
        cam = self.make_camera()
        segment = b"\x01\x00" * 12000
        cam.request_kws_enrollment("help")

        with patch.object(cam.kws_segmenter, "feed", return_value=[segment]), \
                patch.object(KWS_ENGINE, "enroll", return_value={
                    "keyword": "help",
                    "templates": 1,
                    "ready": False,
                    "minimum_templates": 3,
                }):
            cam._process_custom_kws_pcm(b"pcm")

        self.assertEqual(cam.events, [])
        self.assertIsNone(cam.kws_pending_enrollment)
        self.assertEqual(cam.kws_enrollment_status["state"], "captured")
        self.assertEqual(cam.kws_enrollment_status["keyword"], "help")
        self.assertEqual(cam.kws_enrollment_status["templates"], 1)

    def test_no_templates_skips_segmentation_work(self):
        cam = self.make_camera()
        with patch.object(KWS_ENGINE, "has_ready_templates", return_value=False), \
                patch.object(cam.kws_segmenter, "feed") as feed:
            cam._process_custom_kws_pcm(b"pcm")
        feed.assert_not_called()


if __name__ == "__main__":
    unittest.main()
