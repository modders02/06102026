"""One-command official FER2013 Kaggle -> import -> private Supabase -> train.

Run from the training/facial_distress directory with a prepared .venv:
  python run_fer2013.py --accept-kaggle-terms --train
  python run_fer2013.py --archive PATH --accept-kaggle-terms --train
  python run_fer2013.py --accept-kaggle-terms --upload --train
  python run_fer2013.py --image-archive D:/Downloads/archive.zip --accept-kaggle-terms --upload --train

The script does not run in the cloud or schedule jobs. It never integrates
the candidate into live MSDS without independent review.
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def execute(args: list[str]):
    print("\n$ " + " ".join(str(x) for x in args), flush=True)
    subprocess.run(args, cwd=ROOT, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--accept-kaggle-terms", action="store_true", required=True,
                        help="Review/accept original Kaggle competition rules.")
    source_group = parser.add_mutually_exclusive_group()
    source_group.add_argument("--archive", type=Path,
                              help="Use the original Kaggle fer2013.tar.gz/ZIP containing a CSV")
    source_group.add_argument("--image-archive", type=Path,
                              help="Use an authorized 35,887-image FER2013 train/test folder ZIP")
    parser.add_argument("--upload", action="store_true",
                        help="Upload private compressed FER2013 shards to Supabase using server-side key")
    parser.add_argument("--train", action="store_true",
                        help="Train experimental seven-expression MobileNetV3 candidate")
    parser.add_argument("--epochs", type=int, default=12)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--prefix", default="research_v1")
    args = parser.parse_args()

    python = sys.executable
    local_csv = ROOT / "data/fer2013.csv"
    if args.image_archive:
        archive = args.image_archive.resolve()
        if not archive.is_file():
            parser.error(f"FER2013 image archive not found: {archive}")
        images = ROOT / "data/fer2013_cleaned"
        cleaned_zip = ROOT / "data/fer2013_cleaned.zip"
        execute([python, str(ROOT/"import_folder_fer2013.py"),
                 "--archive", str(archive),
                 "--output", str(images),
                 "--cleaned-zip", str(cleaned_zip), "--rights-checked"])
        if args.upload:
            execute([python, str(ROOT/"sync_fer2013_image_zip.py"),
                     "upload", "--zip", str(cleaned_zip),
                     "--prefix", args.prefix, "--confirm-authorized-images"])
    else:
        images = ROOT / "data/expressions"
        if not local_csv.is_file():
            command = [python, str(ROOT/"download_fer2013.py"),
                       "--output", str(local_csv), "--accept-kaggle-terms"]
            if args.archive:
                command += ["--archive", str(args.archive.resolve())]
            execute(command)
        else:
            # Prevent an old, partial CSV silently entering a new training run.
            from download_fer2013 import validate_csv
            validate_csv(local_csv)
            print(f"Verified existing local {local_csv}", flush=True)

        execute([python, str(ROOT/"import_fer2013.py"), "--csv", str(local_csv),
                 "--output", str(images), "--rights-checked"])
        if args.upload:
            execute([python, str(ROOT/"sync_fer2013_bundle.py"), "upload",
                     "--csv", str(local_csv), "--prefix", args.prefix,
                     "--confirm-kaggle-terms"])

    if args.train:
        execute([python,str(ROOT/"train_expressions.py"),
                 "--data",str(images),
                 "--output",str(ROOT/"artifacts/expressions"),
                 "--epochs",str(args.epochs),"--batch-size",str(args.batch_size)])
    else:
        print("FER2013 prepared. Use --train to start candidate training.")
    print("No model has been installed into live CCTV; evaluate before integration.")


if __name__=="__main__":
    main()
