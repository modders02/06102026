"""Offline English emergency-keyword dataset trainer for MSDS.

Usage from the repository root:
    python local-server/train_english_kws.py
    python local-server/train_english_kws.py --dataset D:\\datasets\\msds-english-kws

The dataset must contain labelled WAV folders for each active keyword plus
UNKNOWN. The trainer never downloads models and never fabricates recordings.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

LOCAL_SERVER = Path(__file__).resolve().parent
if str(LOCAL_SERVER) not in sys.path:
    sys.path.insert(0, str(LOCAL_SERVER))

from msds.kws_engine import DEFAULT_KEYWORDS, KWS_ENGINE, NEGATIVE_CLASS  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="Train the English-only MSDS custom KWS.")
    parser.add_argument(
        "--dataset",
        default=str(LOCAL_SERVER / "kws-training-english"),
        help="Folder containing one WAV subfolder per keyword and an unknown folder.",
    )
    parser.add_argument(
        "--keep-existing",
        action="store_true",
        help="Do not clear active English templates before writing dataset templates.",
    )
    args = parser.parse_args()

    print("English thesis-scope keywords:", ", ".join(DEFAULT_KEYWORDS))
    print("Negative class:", NEGATIVE_CLASS)
    report = KWS_ENGINE.train_from_wav_dataset(args.dataset, reset=not args.keep_existing)
    print(json.dumps(report, indent=2))

    if not report.get("success"):
        return 1
    if not report.get("production_ready"):
        print(
            "\nTraining completed, but validation is not production-ready. "
            "Add/clean real recordings until every English keyword is calibrated "
            "and UNKNOWN has enough samples.",
            file=sys.stderr,
        )
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
