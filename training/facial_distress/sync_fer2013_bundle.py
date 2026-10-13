"""Upload or restore official FER2013 as small private Supabase Storage shards.

The existing bucket limits objects to 5 MiB. A CSV is compressed locally
then uploaded in 4 MiB binary objects, with a final integrity manifest.
Only run with Kaggle-authorized data and server-side credentials.
"""
from __future__ import annotations
import argparse
import gzip
import hashlib
import json
import os
import shutil
import tempfile
from pathlib import Path

from download_fer2013 import validate_csv

BUCKET = "msds-emotion-training"
CHUNK_BYTES = 4 * 1024 * 1024


def storage_client():
    from supabase import create_client
    url = os.environ.get("SUPABASE_URL", "").strip()
    secret = (os.environ.get("SUPABASE_SECRET_KEY") or
              os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    if not url or not secret:
        raise RuntimeError(
            "SUPABASE_URL and SUPABASE_SECRET_KEY must be set in your private "
            "PowerShell session, not committed or put in the Electron frontend."
        )
    return create_client(url,secret).storage.from_(BUCKET)


def safe_prefix(prefix: str) -> str:
    if not prefix or not all(c.isascii() and (c.isalnum() or c in "-_") for c in prefix):
        raise ValueError("Prefix may contain only ASCII letters, numbers, '-' and '_'")
    return prefix


def sha256_file(path: Path) -> str:
    digest=hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda:stream.read(1024*1024),b""):
            digest.update(chunk)
    return digest.hexdigest()


def pack_csv(csv_path: Path, output: Path) -> dict:
    """Stream compression to disk without loading the large FER CSV in RAM."""
    counts=validate_csv(csv_path)
    output.parent.mkdir(parents=True,exist_ok=True)
    with csv_path.open("rb") as source, gzip.open(output,"wb",compresslevel=6) as dest:
        shutil.copyfileobj(source,dest,length=1024*1024)
    return {
        "dataset":"FER2013 original Kaggle competition",
        "labels":["angry","disgusted","fearful","happy","sad","surprised","neutral"],
        "split_counts":counts,
        "uncompressed_sha256":sha256_file(csv_path),
        "compressed_sha256":sha256_file(output),
        "compressed_size":output.stat().st_size,
        "chunk_bytes":CHUNK_BYTES,
        "chunks":[],
    }


def upload_csv(csv_path: Path, prefix: str, store):
    safe_prefix(prefix)
    with tempfile.TemporaryDirectory(prefix="fer2013-sync-") as directory:
        packed=Path(directory)/"fer2013.csv.gz"
        manifest=pack_csv(csv_path,packed)
        with packed.open("rb") as stream:
            index=0
            while data:=stream.read(CHUNK_BYTES):
                digest=hashlib.sha256(data).hexdigest()
                name=f"{prefix}/official-fer2013/{manifest['compressed_sha256'][:16]}/part_{index:04d}.bin"
                store.upload(name,data,{
                    "content-type":"application/octet-stream", "upsert":"true"
                })
                manifest["chunks"].append({"key":name,"sha256":digest,"bytes":len(data)})
                print(f"Uploaded part {index+1}: {len(data):,} bytes",flush=True)
                index+=1
        # Publish the manifest *last*, after all binary pieces are present.
        name=f"{prefix}/official-fer2013/manifest.json"
        store.upload(name,json.dumps(manifest,indent=2).encode(),{
            "content-type":"application/json","upsert":"true"
        })
        print(f"FER2013 upload finished: {len(manifest['chunks'])} private chunks")
        return manifest


def download_csv(output: Path,prefix: str,store):
    safe_prefix(prefix)
    key=f"{prefix}/official-fer2013/manifest.json"
    manifest=json.loads(store.download(key).decode())
    if manifest.get("dataset")!="FER2013 original Kaggle competition":
        raise ValueError("Storage manifest is not the expected official FER2013 dataset")
    chunks=manifest.get("chunks") or []
    if not 1<=len(chunks)<=500:
        raise ValueError("Invalid shard count")
    with tempfile.TemporaryDirectory(prefix="fer2013-restore-") as directory:
        compressed=Path(directory)/"fer2013.csv.gz"
        with compressed.open("wb") as output_stream:
            for index,part in enumerate(chunks):
                expected=f"{prefix}/official-fer2013/{manifest['compressed_sha256'][:16]}/part_{index:04d}.bin"
                if part.get("key")!=expected:
                    raise ValueError("Unexpected dataset shard path")
                data=store.download(expected)
                if len(data)!=part["bytes"] or hashlib.sha256(data).hexdigest()!=part["sha256"]:
                    raise ValueError("Dataset shard hash/size mismatch")
                output_stream.write(data)
        if sha256_file(compressed)!=manifest["compressed_sha256"]:
            raise ValueError("Compressed dataset digest mismatch")
        staging=Path(directory)/"fer2013.csv"
        with gzip.open(compressed,"rb") as source, staging.open("wb") as target:
            shutil.copyfileobj(source,target,length=1024*1024)
        if sha256_file(staging)!=manifest["uncompressed_sha256"]:
            raise ValueError("Dataset SHA256 mismatch")
        counts=validate_csv(staging)
        if counts!=manifest["split_counts"]:
            raise ValueError("FER2013 split counts changed")
        output.parent.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(staging,output)
    print(f"Verified and restored official FER2013 to {output}")
    return manifest


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode",choices=["upload","download"])
    parser.add_argument("--csv",type=Path,default=Path("data/fer2013.csv"))
    parser.add_argument("--prefix",default="research_v1")
    parser.add_argument("--confirm-kaggle-terms",action="store_true",required=True,
                        help="Confirm Kaggle account authorization and competition rules")
    args=parser.parse_args()
    store=storage_client()
    if args.mode=="upload":
        upload_csv(args.csv,args.prefix,store)
    else:
        download_csv(args.csv,args.prefix,store)


if __name__=="__main__":
    main()
