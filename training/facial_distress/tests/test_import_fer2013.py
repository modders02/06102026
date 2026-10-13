"""Small deterministic FER2013 importer tests; no facial photos or downloads."""
from __future__ import annotations

import csv
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from import_fer2013 import CLASSES, import_fer2013, parse_pixels


def pixel_string(value: int) -> str:
    return " ".join([str(value)] * 2304)


class FerImporterTests(unittest.TestCase):
    def test_class_order_is_complete_and_distinguishes_fear_from_surprise(self):
        self.assertEqual(
            CLASSES,
            ("angry", "disgusted", "fearful", "happy", "sad",
             "surprised", "neutral"),
        )

    def test_bad_pixels_are_rejected(self):
        with self.assertRaises(ValueError):
            parse_pixels("0 1")
        with self.assertRaises(ValueError):
            parse_pixels(pixel_string(256))
        with self.assertRaises(ValueError):
            parse_pixels("word " * 2304)

    def test_splits_and_duplicate_prevention(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "fer2013.csv"
            dest = root / "processed"
            with source.open("w", newline="", encoding="utf-8") as handle:
                writer = csv.writer(handle)
                writer.writerow(["emotion", "pixels", "Usage"])
                writer.writerow([3, pixel_string(101), "Training"])
                writer.writerow([2, pixel_string(102), "Training"])
                writer.writerow([5, pixel_string(103), "PublicTest"])
                writer.writerow([4, pixel_string(104), "PrivateTest"])
                writer.writerow([3, pixel_string(101), "PrivateTest"])
            manifest = import_fer2013(source, dest)
            self.assertEqual(manifest["duplicates_omitted"], 1)
            self.assertEqual(manifest["counts"]["train/happy"], 1)
            self.assertEqual(manifest["counts"]["train/fearful"], 1)
            self.assertEqual(manifest["counts"]["val/surprised"], 1)
            self.assertEqual(manifest["counts"]["test/sad"], 1)
            self.assertFalse((dest / "test" / "happy").exists())
            self.assertEqual(len(list(dest.rglob("*.png"))), 4)
            self.assertTrue((dest / "fer2013_import.json").is_file())

    def test_invalid_split_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "fer2013.csv"
            source.write_text("emotion,pixels,Usage\n3," + '"' + pixel_string(12)
                              + '",UnknownTest\n', encoding="utf-8")
            with self.assertRaises(ValueError):
                import_fer2013(source, root / "processed")


if __name__ == "__main__":
    unittest.main()
