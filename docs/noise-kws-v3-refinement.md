# MSDS V3 refinement — preserve original checkpoint and evaluate frozen model

**Branch:** experiment/kws-v3-refinement-audit-20261031
**Parent:** experiment/noise-kws-v3-validation-20261031

## Why return to V3?

V3 achieved 11/35 accepted positives (31.43%) on its original
session-separated development set, but has NOT been tested on the same
55 fresh capture recordings used to evaluate V4.1 and V5.

V4.1 accepted 4/35 and V5 pretrained Sherpa 3/35 on those newer
recordings. Those new recordings have now been repeatedly observed,
so additional comparison with V3 is exploratory, not a sealed test.

The original V3 train and development-validation split shares a speaker,
so session-disjoint metrics do not establish independent voice
generalization. The old 31-WAV holdout has been accessed previously.

**Do not claim V3 is superior on fresh speakers until a matched dataset
comparison is run.** Avoid creating an untested V3.1 variant from
multiple ad-hoc threshold experiments.

## Concrete refinements

1. New read-only original V3 evaluator runs the FROZEN V3 MLP on exactly
   the saved WAVs using its original feature pipeline: 16 x 32 Log-Mel
   representation and original 0.80 confidence/0.15 margin gate.
2. It verifies unchanged NPZ metadata against the original training
   report, original grouped-split membership SHA and original manifest;
   refuses exact WAV byte duplicates, test-set duplicates, training/
   legacy holdout paths and missing class directories.
3. Reports per-keyword raw argmax correctness and fixed-gate accepted
   correctness, rejection reason, confusion, UNKNOWN false positives,
   and per-file confidence. No automatic labeling or speaker verification.
4. Original V3 training now REFUSES TO OVERWRITE an existing model or
   its JSON report. To conduct a later development-control training
   experiment, use a distinct output filename via --candidate-name.
   Do NOT retrain until fresh multi-speaker development data exists.

## Use in Windows PowerShell

From repo root:

    cd "C:\Users\nazar\Documents\ongoin\06102026-kws"
    git status --short
    git fetch origin
    git switch --track origin/experiment/kws-v3-refinement-audit-20261031

If the branch exists locally, use git switch and git pull --ff-only.
Never delete or reset local ignored private recordings or NPZ artifacts.

Compute absolute directory path:

    $testData = Join-Path (Get-Location).Path "local-server\neural-kws-data\independent-v41-test-20261101"

Check checkpoint + manifest + 55-WAV input without evaluating:

    .\local-server\evaluate_noise_kws_v3_frozen.cmd --test-data "$testData" --check

Then run read-only original V3 comparison:

    .\local-server\evaluate_noise_kws_v3_frozen.cmd --test-data "$testData"

A report is saved ONCE, under the existing private Git-ignored data:

    local-server/neural-kws-data/artifacts/noise_augmented_shadow_v3.frozen-new-recordings.json

The evaluator never trains, updates a threshold, edits source recordings,
accesses legacy holdout audio, changes manually enrolled DTW KWS, calls
the camera, routes external alerts, or modifies active event history.

## Later, AFTER new speakers are collected

A separate NEW research checkpoint can be trained with:

    .\local-server\train_noise_kws_v3.cmd --group-by speaker --check
    .\local-server\train_noise_kws_v3.cmd --group-by speaker --candidate-name noise_augmented_shadow_v3_control.npz

The check will refuse speaker-disjoint mode unless at least two
independent speakers per class exist. Build an anonymized group manifest
with operator-verified speaker IDs; never guess identity from filenames.
The new name is mandatory to avoid destroying baseline V3. The
original V3 checkpoint, report and all prior V4/V4.1/V5/V6
experiments remain untouched.

## Evaluation limitations and next actions

This 55-WAV set was already used to observe V4.1/V5 results and cannot
serve as an unbiased final-test set for selecting V3. A small UNKNOWN
sample with no false positives provides no guarantee of low errors per
hour under continuous noisy CCTV audio.

Before any operational use: validate spoken words by listening, record
speaker/session provenance, recruit several consenting new speakers,
freeze model/decision thresholds/preprocessing, collect a sealed new
test set, and evaluate recall for each of seven emergency keywords,
false alarms per hour, missed words, camera PCM interruptions and
hardware latency. Define pass requirements before looking at the
sealed final test.

Stable operational MSDS, stable_branch_271026, manual DTW enrollment,
Camera Alerts, Event History and notifications are unchanged.
