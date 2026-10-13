"""Securely sync authorized expression images with private Supabase Storage.

Use a server-side secret stored in environment variables, never in git.
User photos require consent; synthetic assets require accurate provenance.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
from urllib.parse import quote

from supabase import create_client

CLASSES = ("angry","disgusted","fearful","happy","sad","surprised","neutral")
SPLITS = ("train","val","test")
EXTENSIONS = {".jpg":"image/jpeg",".jpeg":"image/jpeg",".png":"image/png",".webp":"image/webp"}
BUCKET = "msds-emotion-training"


def client():
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SECRET_KEY") or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise RuntimeError("Set SUPABASE_URL and SUPABASE_SECRET_KEY in this terminal. Never commit them.")
    return create_client(url, key)


def objects(root: Path, prefix: str):
    if not prefix or "/" in prefix or prefix in (".", ".."):
        raise ValueError("Use a single project-specific prefix without slashes")
    for split in SPLITS:
        for label in CLASSES:
            folder = root / split / label
            if not folder.is_dir():
                continue
            for path in sorted(folder.iterdir()):
                if path.is_file() and path.suffix.lower() in EXTENSIONS:
                    if path.stat().st_size > 5_000_000:
                        raise ValueError(f"File exceeds 5MB: {path}")
                    digest = hashlib.sha256(path.read_bytes()).hexdigest()
                    yield path, f"{prefix}/{split}/{label}/{digest[:20]}{path.suffix.lower()}",digest


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("mode",choices=["upload","download"])
    ap.add_argument("--root",type=Path,default=Path("data/expressions"))
    ap.add_argument("--prefix",default="research-v1")
    ap.add_argument("--confirm-authorized-images",action="store_true")
    args=ap.parse_args()
    if not args.confirm_authorized_images:
        ap.error("You must confirm permission/consent and verify all image labels.")
    db=client()
    storage=db.storage.from_(BUCKET)
    manifest=[]
    if args.mode=="upload":
        for path,key,digest in objects(args.root,args.prefix):
            storage.upload(key,path.read_bytes(),{"content-type":EXTENSIONS[path.suffix.lower()],"upsert":"false"})
            manifest.append({"key":key,"sha256":digest,"class":path.parent.name,"split":path.parent.parent.name})
        manifest_path=args.root/"supabase_dataset_manifest.json"
        manifest_path.write_text(json.dumps({"bucket":BUCKET,"items":manifest},indent=2),encoding="utf-8")
        print(f"Uploaded {len(manifest)} files to private bucket {BUCKET}. Manifest: {manifest_path}")
    else:
        if not args.prefix or "/" in args.prefix: ap.error("Invalid prefix")
        for split in SPLITS:
            for label in CLASSES:
                path=f"{args.prefix}/{split}/{label}"
                offset=0
                while True:
                    entries=storage.list(path,{"limit":100,"offset":offset})
                    if not entries: break
                    for entry in entries:
                        name=entry.get("name","")
                        suffix=Path(name).suffix.lower()
                        if suffix not in EXTENSIONS: continue
                        target=args.root/split/label/name
                        target.parent.mkdir(parents=True,exist_ok=True)
                        if not target.exists():
                            target.write_bytes(storage.download(f"{path}/{name}"))
                        manifest.append(str(target))
                    offset+=len(entries)
                    if len(entries)<100: break
        print(f"Downloaded {len(manifest)} authorized images to {args.root}")


if __name__=="__main__":
    main()
