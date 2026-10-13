"""Safely train English emergency keywords: preview, backup, then explicit apply.

From the repository root:
  .\\local-server\\.venv\\Scripts\\python.exe local-server/train_english_kws.py --backup-only
  .\\local-server\\.venv\\Scripts\\python.exe local-server/train_english_kws.py
  .\\local-server\\.venv\\Scripts\\python.exe local-server/train_english_kws.py --apply

Plain invocation trains only an isolated *candidate*. It NEVER changes active
model templates. Applying requires successful template calibration and separate
held-out speech tests, then archives and swaps the active templates.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from msds.kws_engine import (  # noqa: E402
    CustomKeywordEngine, DEFAULT_KEYWORDS, KWS_ENGINE, NEGATIVE_CLASS, SAMPLE_RATE,
)

MIN_TRAIN_PER_WORD = 5
MIN_TRAIN_UNKNOWN = 10
MIN_HOLDOUT_PER_WORD = 3
MIN_HOLDOUT_UNKNOWN = 10
MIN_POSITIVE_RECALL = 0.90
MAX_UNKNOWN_FALSE_ALARM = 0.05


def backup_templates(source: Path, output: Path) -> Path:
    """Archive current templates before any model changes; never modify source."""
    output.mkdir(parents=True, exist_ok=True)
    name = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    dest = output / f"msds-kws-{name}-{uuid.uuid4().hex[:8]}.zip"
    written = 0
    try:
        with zipfile.ZipFile(dest, "x", compression=zipfile.ZIP_DEFLATED) as archive:
            for path in sorted(source.rglob("*.npy")) if source.exists() else []:
                if path.is_symlink() or not path.is_file():
                    continue
                archive.write(path, arcname=str(path.relative_to(source)).replace("\\", "/"))
                written += 1
            archive.writestr("backup_info.json", json.dumps({
                "utc": datetime.now(timezone.utc).isoformat(),
                "template_count": written,
                "source": str(source.resolve()),
            }, indent=2))
        with zipfile.ZipFile(dest) as archive:
            if archive.testzip() is not None:
                raise IOError("Backup archive failed checksum verification.")
    except Exception:
        dest.unlink(missing_ok=True)
        raise
    return dest


def heldout_report(engine: CustomKeywordEngine, root: Path) -> dict:
    """Evaluate real *unseen* WAV files; these must not appear in training."""
    by_label: dict[str, dict] = {}
    total_positive = correct_positive = total_unknown = false_unknown = 0
    for label in (*DEFAULT_KEYWORDS, NEGATIVE_CLASS):
        files = sorted((root / label).glob("*.wav")) if (root / label).is_dir() else []
        passed = rejected = 0
        failures = []
        for file in files:
            try:
                pcm = engine._read_wav_as_pcm16k_mono(file)
                if not 0.30 <= len(pcm) / (2 * SAMPLE_RATE) <= 2.50:
                    raise ValueError("Recording must contain a 0.3-2.5 second utterance.")
                decision = engine.diagnose(pcm)
                predicted = decision.keyword if decision and decision.accepted else None
                ok = (predicted == label) if label != NEGATIVE_CLASS else (predicted is None)
                passed += int(ok)
                rejected += int(not ok)
                if not ok:
                    failures.append({"file": file.name, "predicted": predicted,
                                     "reason": decision.reason if decision else "no_match"})
            except Exception as exc:
                rejected += 1
                failures.append({"file": file.name, "error": str(exc)})
        if label == NEGATIVE_CLASS:
            total_unknown += len(files)
            false_unknown += rejected
        else:
            total_positive += len(files)
            correct_positive += passed
        minimum = MIN_HOLDOUT_UNKNOWN if label == NEGATIVE_CLASS else MIN_HOLDOUT_PER_WORD
        by_label[label] = {"files": len(files), "correct": passed, "errors": failures,
                           "minimum": minimum, "enough": len(files) >= minimum}
    recall = correct_positive / total_positive if total_positive else 0.0
    fpr = false_unknown / total_unknown if total_unknown else 1.0
    return {
        "root": str(root), "by_label": by_label,
        "positive_recall": round(recall, 3),
        "unknown_false_alarm_rate": round(fpr, 3),
        "pass": bool(
            all(item["enough"] for item in by_label.values())
            and recall >= MIN_POSITIVE_RECALL
            and fpr <= MAX_UNKNOWN_FALSE_ALARM
        ),
        "minimum_positive_recall": MIN_POSITIVE_RECALL,
        "maximum_unknown_false_alarm_rate": MAX_UNKNOWN_FALSE_ALARM,
    }


def training_coverage(report: dict) -> dict:
    classes = report.get("classes", {})
    return {
        label: {"recordings": classes.get(label, {}).get("templates_written", 0),
                "minimum": MIN_TRAIN_UNKNOWN if label == NEGATIVE_CLASS else MIN_TRAIN_PER_WORD}
        for label in (*DEFAULT_KEYWORDS, NEGATIVE_CLASS)
    }


def install_candidate(candidate: Path, active: Path) -> None:
    """Swap a validated candidate with a rollback in case filesystem move fails.

    The caller MUST create and verify a backup archive before reaching here.
    Close the running MSDS bridge before executing --apply.
    """
    active.parent.mkdir(parents=True, exist_ok=True)
    staging = active.parent / f".{active.name}-new-{uuid.uuid4().hex}"
    retired = active.parent / f".{active.name}-previous-{uuid.uuid4().hex}"
    shutil.copytree(candidate, staging)
    moved_old = False
    try:
        if active.exists():
            active.rename(retired)
            moved_old = True
        staging.rename(active)
    except BaseException:
        if moved_old and retired.exists() and not active.exists():
            retired.rename(active)
        raise
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    if retired.exists():
        shutil.rmtree(retired)


def main() -> int:
    parser = argparse.ArgumentParser(description="Safely train the seven active MSDS English emergency keywords.")
    parser.add_argument("--dataset", type=Path, default=HERE / "kws-training-english")
    parser.add_argument("--holdout", type=Path, default=HERE / "kws-holdout-english")
    parser.add_argument("--backup-only", action="store_true",
                        help="Archive the active KWS templates without training.")
    parser.add_argument("--apply", action="store_true",
                        help="Backup then install only if calibration and held-out checks pass.")
    parser.add_argument("--keep-existing", action="store_true",
                        help="Deprecated; safe training uses independent full candidate templates.")
    args = parser.parse_args()
    if args.keep_existing:
        parser.error("--keep-existing is disabled to prevent accidentally mixing old and new templates.")
    if args.backup_only and args.apply:
        parser.error("--backup-only cannot be combined with --apply")

    backup_root = HERE / "kws-backups"
    active = KWS_ENGINE.data_dir
    if args.backup_only:
        dest = backup_templates(active, backup_root)
        print(json.dumps({"success": True, "backup": str(dest),
                          "active_template_dir": str(active)}, indent=2))
        return 0

    dataset = args.dataset.resolve()
    holdout = args.holdout.resolve()
    # Do not score a training file as held-out evidence.
    if dataset == holdout or dataset in holdout.parents or holdout in dataset.parents:
        parser.error("Training and holdout datasets must be in separate directories.")
    if not dataset.is_dir():
        print(f"Training directory missing: {dataset}", file=sys.stderr)
        return 1
    print("Mode:", "APPLY WITH BACKUP" if args.apply else "ISOLATED PREVIEW (no deployment)")
    print("Keywords:", ", ".join(DEFAULT_KEYWORDS), "| negative:", NEGATIVE_CLASS)
    with tempfile.TemporaryDirectory(prefix="msds-english-kws-candidate-") as folder:
        candidate = Path(folder) / "candidate"
        engine = CustomKeywordEngine(data_dir=str(candidate))
        report = engine.train_from_wav_dataset(dataset, reset=True)
        coverage = training_coverage(report)
        enough = all(item["recordings"] >= item["minimum"] for item in coverage.values())
        holdout_results = heldout_report(engine, holdout)
        ready = bool(report.get("success") and report.get("production_ready") and enough
                     and holdout_results["pass"])
        print(json.dumps({
            "success": report.get("success"),
            "candidate_only": not args.apply,
            "training_coverage": coverage,
            "calibrated": report.get("production_ready", False),
            "evaluation": report.get("evaluation"),
            "holdout": holdout_results,
            "eligible_to_apply": ready,
            "rejected_wav_files": {key: value.get("rejected", [])
                                   for key, value in report.get("classes", {}).items()
                                   if value.get("rejected")},
        }, indent=2))
        if not args.apply:
            print("Candidate discarded after preview; active templates were not changed.")
            return 0 if report.get("success") else 1
        if not ready:
            print("NOT APPLIED: insufficient examples, poor calibration or holdout failures. "
                  "Current templates remain unchanged.", file=sys.stderr)
            return 2
        archive = backup_templates(active, backup_root)
        print(f"Verified original-template backup: {archive}", flush=True)
        install_candidate(candidate, active)
        print("New templates installed. Restart the MSDS camera bridge to load them. "
              "This does NOT establish real-world emergency safety reliability.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
