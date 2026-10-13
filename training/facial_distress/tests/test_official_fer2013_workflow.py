"""Offline FER2013 Kaggle archive and private Supabase shard regressions."""
from __future__ import annotations

import io
import sys
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from download_fer2013 import extract_csv
import sync_fer2013_bundle as bundle

SMALL_CSV=b"emotion,pixels,Usage\n3,1 2 3,Training\n"


class MemoryStore:
    def __init__(self):
        self.items={}
    def upload(self,name,data,options):
        self.items[name]=bytes(data)
    def download(self,name):
        return self.items[name]


class OfficialFer2013WorkflowTests(unittest.TestCase):
    def test_direct_kaggle_tar_extract_does_not_unpack_other_files(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            tar=root/"fer2013.tar.gz"
            with tarfile.open(tar,"w:gz") as out:
                member=tarfile.TarInfo("fer2013/fer2013.csv")
                member.size=len(SMALL_CSV)
                out.addfile(member,io.BytesIO(SMALL_CSV))
                malicious=tarfile.TarInfo("../../outside.txt")
                malicious.size=4
                out.addfile(malicious,io.BytesIO(b"evil"))
            with patch("download_fer2013.validate_csv",return_value={"Training":1}):
                target=root/"data"/"fer2013.csv"
                self.assertEqual(extract_csv(tar,target),target)
            self.assertEqual(target.read_bytes(),SMALL_CSV)
            self.assertFalse((root/"outside.txt").exists())

    def test_kaggle_zip_containing_original_tar(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            archive=root/"official.zip"
            tar_buffer=io.BytesIO()
            with tarfile.open(fileobj=tar_buffer,mode="w:gz") as inner:
                item=tarfile.TarInfo("fer2013/fer2013.csv")
                item.size=len(SMALL_CSV)
                inner.addfile(item,io.BytesIO(SMALL_CSV))
            with zipfile.ZipFile(archive,"w") as outer:
                outer.writestr("fer2013.tar.gz",tar_buffer.getvalue())
            with patch("download_fer2013.validate_csv",return_value={"Training":1}):
                target=root/"fer2013.csv"
                extract_csv(archive,target)
                self.assertEqual(target.read_bytes(),SMALL_CSV)

    def test_rejects_zip_without_dataset(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            archive=root/"official.zip"
            with zipfile.ZipFile(archive,"w") as outer:
                outer.writestr("../evil",b"evil")
            with self.assertRaises(ValueError):
                extract_csv(archive,root/"fer2013.csv")

    def test_private_supabase_shards_roundtrip_with_integrity(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            original=root/"data"/"fer2013.csv"
            original.parent.mkdir(parents=True)
            original.write_bytes(SMALL_CSV*20)
            store=MemoryStore()
            counts={"Training":28709,"PublicTest":3589,"PrivateTest":3589}
            with patch("sync_fer2013_bundle.validate_csv",return_value=counts), \
                 patch.object(bundle,"CHUNK_BYTES",30):
                manifest=bundle.upload_csv(original,"research_v1",store)
                self.assertGreater(len(manifest["chunks"]),1)
                saved=root/"restore"/"fer2013.csv"
                bundle.download_csv(saved,"research_v1",store)
                self.assertEqual(saved.read_bytes(),original.read_bytes())
                self.assertEqual(manifest["split_counts"],counts)
                # Corrupt one shard. Retrieval must reject it.
                name=manifest["chunks"][0]["key"]
                store.items[name]=b"wrong contents"
                with self.assertRaises(ValueError):
                    bundle.download_csv(root/"bad.csv","research_v1",store)
                self.assertFalse((root/"bad.csv").exists())

    def test_invalid_path_prefix_rejected(self):
        for invalid in ["", "../other", "other/user", "other space", "."]:
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                bundle.safe_prefix(invalid)


if __name__=="__main__":
    unittest.main()
