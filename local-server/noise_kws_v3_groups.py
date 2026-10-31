"""Speaker/session manifest and strictly grouped training-only validation.

No identity is inferred from timestamps or filenames. The operator labels each
consented recording with anonymized IDs. A source, and all its augmentations,
belong to only ONE split. The final holdout directory is never inspected here.
"""
from __future__ import annotations

import csv
from collections import Counter, defaultdict
import hashlib
import io
from pathlib import Path
import re

import numpy as np

from prepare_neural_kws import KEYWORDS

GROUP_LABELS = (*KEYWORDS, "unknown")
MANIFEST_COLUMNS = ("relative_path", "speaker_id", "session_id", "sha256")
_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def list_training_wavs(root: Path) -> dict[str, str]:
    """Index only allowed train WAVs; never infer speaker or session identity."""
    indexed = {}
    for folder in (*GROUP_LABELS, "hard_negative"):
        directory = root / "train" / folder
        if not directory.is_dir():
            continue
        for item in sorted(directory.iterdir()):
            if item.suffix.lower() != ".wav" or not item.is_file() or item.is_symlink():
                continue
            rel = item.relative_to(root).as_posix()
            indexed[rel] = "unknown" if folder == "hard_negative" else folder
    return indexed


def refresh_group_manifest(root: Path, target: Path) -> dict:
    """Preserve existing annotations, add unassigned new WAVs, never silently prune."""
    indexed = list_training_wavs(root)
    existing = {}
    if target.is_file():
        with target.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            if tuple(reader.fieldnames or ()) != MANIFEST_COLUMNS:
                raise ValueError("Existing manifest has unsupported columns; no changes made")
            for row in reader:
                rel = row["relative_path"]
                if rel in existing:
                    raise ValueError(f"Duplicate manifest entry: {rel}")
                existing[rel] = row
        stale = sorted(set(existing) - set(indexed))
        if stale:
            raise ValueError(
                "Manifest refers to missing/quarantined WAV(s); correct the "
                "manifest manually before refreshing: " + ", ".join(stale[:5])
            )
    rows = []
    for rel in sorted(indexed):
        item = root / rel
        digest = hashlib.sha256(item.read_bytes()).hexdigest()
        prev = existing.get(rel)
        if prev and prev["sha256"] != digest:
            raise ValueError(f"WAV contents changed since annotation: {rel}")
        rows.append({
            "relative_path": rel,
            "speaker_id": (prev or {}).get("speaker_id", ""),
            "session_id": (prev or {}).get("session_id", ""),
            "sha256": digest,
        })
    target.parent.mkdir(parents=True, exist_ok=True)
    with io.StringIO(newline="") as out:
        writer = csv.DictWriter(out, fieldnames=MANIFEST_COLUMNS, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
        text = out.getvalue()
    if not target.exists() or target.read_text(encoding="utf-8-sig") != text:
        target.write_text(text, encoding="utf-8")
    return {
        "manifest": str(target),
        "training_files": len(rows),
        "new_unassigned_files": len(indexed) - len(existing),
        "unassigned_total": sum(not row["speaker_id"] or not row["session_id"] for row in rows),
    }


def load_group_manifest(root: Path, target: Path) -> list[dict]:
    indexed = list_training_wavs(root)
    if not target.is_file():
        raise ValueError("Group manifest missing; run --init-groups first")
    with target.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        if tuple(reader.fieldnames or ()) != MANIFEST_COLUMNS:
            raise ValueError(f"Group manifest must use columns: {MANIFEST_COLUMNS}")
        rows = list(reader)
    seen = set()
    annotated = []
    for row in rows:
        rel = row["relative_path"]
        if rel in seen or rel not in indexed:
            raise ValueError(f"Duplicate or unexpected WAV in group manifest: {rel}")
        seen.add(rel)
        speaker, session = row["speaker_id"], row["session_id"]
        if not _ID.fullmatch(speaker or "") or not _ID.fullmatch(session or ""):
            raise ValueError(
                f"Assign anonymized speaker_id and session_id for {rel} "
                "(letters, digits, dash, underscore; 1-64 characters)."
            )
        digest = hashlib.sha256((root / rel).read_bytes()).hexdigest()
        if row["sha256"] != digest:
            raise ValueError(f"WAV changed after manifest generation: {rel}")
        annotated.append({
            "relative_path": rel, "label": indexed[rel],
            "speaker_id": speaker, "session_id": session,
            "sha256": digest,
        })
    missing = sorted(set(indexed) - seen)
    if missing:
        raise ValueError(
            f"{len(missing)} unannotated training WAV(s), first: {missing[0]}. "
            "Run --init-groups to add rows and assign anonymized IDs."
        )
    if not annotated:
        raise ValueError("No labeled training WAVs")
    return annotated


def group_key(item: dict, group_by: str) -> str:
    if group_by == "speaker":
        return f"speaker:{item['speaker_id']}"
    if group_by == "session":
        return f"session:{item['speaker_id']}:{item['session_id']}"
    raise ValueError("group_by must be speaker or session")


def split_grouped(rows: list[dict], *, group_by: str = "speaker",
                  seed: int = 42, fraction: float = 0.25) -> tuple[list[dict], list[dict], dict]:
    """Assign WHOLE speakers/sessions to validation, with every class on both sides.

    Samples cannot be independently shuffled. A group can contain several
    keywords, in which case they ALL move together. The stochastic search
    is deterministic given seed; it never reads the external holdout.
    """
    if not 0.15 <= fraction <= 0.40:
        raise ValueError("Validation fraction must be 0.15–0.40")
    if not rows:
        raise ValueError("No group-labeled data")
    by_group = defaultdict(list)
    per_label_groups = defaultdict(set)
    for row in rows:
        label = row["label"]
        if label not in GROUP_LABELS:
            raise ValueError(f"Unexpected training class: {label}")
        key = group_key(row, group_by)
        by_group[key].append(row)
        per_label_groups[label].add(key)
    missing_classes = [
        name for name in GROUP_LABELS if len(per_label_groups[name]) < 2
    ]
    if missing_classes:
        raise ValueError(
            f"Cannot create {group_by}-disjoint validation: need at least "
            f"TWO separate {group_by} groups for each class. "
            f"Missing: {', '.join(missing_classes)}. Record consenting new "
            "speakers/sessions, then refresh and annotate the group manifest."
        )
    keys = sorted(by_group)
    if len(keys) < 2:
        raise ValueError("At least 2 independent groups are required")
    rng = np.random.default_rng(seed)
    labels = set(GROUP_LABELS)
    all_counts = Counter(row["label"] for row in rows)
    best = None
    best_score = float("inf")
    attempts = min(16000, max(1200, len(keys) * 350))
    for _ in range(attempts):
        chosen = {key for key in keys if rng.random() < fraction}
        if not chosen or len(chosen) == len(keys):
            continue
        val_counts = Counter(row["label"] for key in chosen for row in by_group[key])
        if any(val_counts[label] == 0 or val_counts[label] >= all_counts[label] for label in labels):
            continue
        val_size = sum(val_counts.values())
        score = abs(val_size / len(rows) - fraction)
        score += sum(abs(val_counts[label] / all_counts[label] - fraction)
                     for label in labels) / len(labels)
        if score < best_score:
            best_score = score
            best = chosen
    if best is None:
        raise ValueError(
            "No group-disjoint split preserves train AND validation coverage "
            "for all eight classes. Collect more independent speaker/session "
            "groups across classes and refresh the manifest."
        )
    train = [row for row in rows if group_key(row, group_by) not in best]
    validation = [row for row in rows if group_key(row, group_by) in best]
    speaker_train = {row["speaker_id"] for row in train}
    speaker_val = {row["speaker_id"] for row in validation}
    overlap = sorted(speaker_train & speaker_val)
    detail = {
        "group_by": group_by,
        "train_sources": len(train),
        "validation_sources": len(validation),
        "training_counts": dict(Counter(row["label"] for row in train)),
        "validation_counts": dict(Counter(row["label"] for row in validation)),
        "speaker_overlap_count": len(overlap),
        "speaker_disjoint": len(overlap) == 0,
        "session_only_warning": (
            "Same speaker appears in both splits; session-disjoint validation "
            "does not demonstrate generalization to new voices."
            if overlap else None
        ),
    }
    return train, validation, detail
