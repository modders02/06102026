"""Offline tests for the user-uploaded FER2013 folder ZIP and Supabase shards."""
import io
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from import_folder_fer2013 import dataset_entry, import_zip
from sync_fer2013_image_zip import download, upload, validate_archive


def jpeg(value):
    img = Image.new("L", (48, 48), color=value)
    out = io.BytesIO()
    img.save(out, format="JPEG")
    return out.getvalue()


class Storage:
    def __init__(self):
        self.data = {}
    def upload(self, key, data, options):
        self.data[key] = bytes(data)
    def download(self, key):
        return self.data[key]


class ImageFolderTests(unittest.TestCase):
    def test_expected_kaggle_image_folders(self):
        self.assertEqual(dataset_entry("train/fear/Training_1.jpg"),
                         ("train", "fearful", "Training_1.jpg"))
        self.assertEqual(dataset_entry("test/surprise/PublicTest_1.jpg"),
                         ("val", "surprised", "PublicTest_1.jpg"))
        self.assertEqual(dataset_entry("test/disgust/PrivateTest_1.jpg"),
                         ("test", "disgusted", "PrivateTest_1.jpg"))

    def test_uploaded_zip_split_and_conflicting_label_removal(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            original = root / "archive.zip"
            with zipfile.ZipFile(original, "w") as out:
                out.writestr("train/happy/Training_1.jpg", jpeg(20))
                out.writestr("test/happy/PrivateTest_1.jpg", jpeg(20))
                out.writestr("test/fear/PublicTest_2.jpg", jpeg(40))
                out.writestr("train/surprise/Training_3.jpg", jpeg(60))
                # Same exact JPEG cannot carry two different expression labels.
                out.writestr("train/angry/Training_4.jpg", jpeg(60))
                out.writestr("train/neutral/Training_5.jpg", jpeg(80))
            destination = root / "prepared"
            clean_archive = root / "prepared.zip"
            stats = import_zip(original, destination, clean_archive)
            self.assertEqual(stats["source_image_count"], 6)
            self.assertEqual(stats["clean_image_count"], 3)
            self.assertEqual(stats["duplicate_extra_files"], 2)
            self.assertEqual(stats["conflicting_label_groups_excluded"], 1)
            self.assertFalse((destination / "train" / "happy").exists())
            self.assertTrue((destination / "test" / "happy" / "PrivateTest_1.jpg").exists())
            self.assertTrue((destination / "val" / "fearful" / "PublicTest_2.jpg").exists())
            self.assertFalse((destination / "train" / "angry").exists())
            self.assertEqual(validate_archive(clean_archive)["clean_image_count"], 3)
            # Reimporting the same source does not mix or overwrite observations.
            self.assertEqual(import_zip(original, destination, clean_archive), stats)

    def test_rejects_bad_zip_member_and_reimport_mismatch(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            source = root / "dataset.zip"
            with zipfile.ZipFile(source, "w") as out:
                out.writestr("../secret.jpg", jpeg(40))
            with self.assertRaises(ValueError):
                import_zip(source, root / "output")
            with zipfile.ZipFile(source, "w") as out:
                out.writestr("train/happy/Training_1.jpg", jpeg(20))
            import_zip(source, root / "output")
            with zipfile.ZipFile(source, "w") as out:
                out.writestr("train/happy/Training_2.jpg", jpeg(90))
            with self.assertRaises(ValueError):
                import_zip(source, root / "output")

    def test_verified_private_shard_roundtrip(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            original = root / "archive.zip"
            with zipfile.ZipFile(original, "w") as out:
                out.writestr("train/neutral/Training_1.jpg", jpeg(80))
            prepared = root / "clean.zip"
            import_zip(original, root / "prepared", prepared)
            storage = Storage()
            metadata = upload(prepared, "research_v1", storage)
            self.assertEqual(metadata["clean_image_count"], 1)
            destination = root / "restored.zip"
            download(destination, "research_v1", storage)
            self.assertEqual(destination.read_bytes(), prepared.read_bytes())
            shard = metadata["entries"][0]["key"]
            storage.data[shard] = b"corruption"
            with self.assertRaises(ValueError):
                download(root / "corrupt.zip", "research_v1", storage)
            self.assertFalse((root / "corrupt.zip").exists())


if __name__ == "__main__":
    unittest.main()
