# MSDS KWS V3 — validation-controlled, noise-augmented research experiment

Branch: experiment/noise-kws-v3-validation-20261031
Parent: experiment/noise-augment-training-20261031

This is NOT a production KWS change. Stable DTW templates, original manual
enrollment, pretrained Zipformer, emergency alerts, V1 and V2 NPZ files are
untouched. It trains a new small 32-hidden-unit classifier only after operator-
verified, anonymized speaker/session groups can be split without overlap.

## Why V3

On the first small corpus, V1 yielded 19.05% positive recall and 10% false
positive fraction on 21 positive and 10 unknown held-out WAVs. V2 reached
38.10% and 30%, respectively, still unsafe for automatic alert decisions.
With only three test WAVs per emergency class, these are descriptive results,
not credible population-level reliability estimates.

V3 improves the evaluation *method*, not guaranteed accuracy:
- 32 hidden units instead of 64, dropout=0.25 and L2=0.003
- class-balanced minibatches including UNKNOWN
- checkpoint selection by training-only macro validation loss
- early stopping (patience=12 by default), not hard-coded epoch-60 output
- whole SPEAKER groups separated by default; optional session-only split
  explicitly marks any speaker overlap and cannot establish new-voice recall
- all augmented variants of a source WAV remain in TRAIN, never validation
- separate V3 output: artifacts/noise_augmented_shadow_v3.npz
- optional hard-negative speech in train/hard_negative (labeled UNKNOWN)
- FIRE-specific trim/duration and per-file confusion diagnostics in report
- optional *exploratory only* old holdout evaluation, NOT used in optimization

## Before training: annotate real people/sessions without using real names

On Windows PowerShell in the repo:

    cd "C:\Users\nazar\Documents\ongoin\06102026-kws"
    git fetch origin
    git switch --track origin/experiment/noise-kws-v3-validation-20261031

Build a PRIVATE CSV template from locally stored train WAV files:

    .\local-server\train_noise_kws_v3.cmd --init-groups

This creates:

    local-server/neural-kws-data/group_manifest_v3.csv

Open in Notepad, Excel, or a CSV editor:

    notepad .\local-server\neural-kws-data\group_manifest_v3.csv

Each row contains:

    relative_path,speaker_id,session_id,sha256

The WAV path and its SHA256 are populated automatically. FILL speaker_id and
session_id for EVERY row using short pseudonymous tags. A single person's
recordings, across all words and days, MUST use the same speaker_id, such as
voice_a. Different consenting people must use different tags such as
voice_b. Use session_1, session_2, etc. for genuinely separate recording
sessions (not a new label per individual recording). Do not infer speaker
identity from filenames or invent a new speaker to make validation succeed.
Do not change relative_path or sha256. Keep the CSV private and Git ignored;
never commit raw WAVs or speaker metadata.

The default is SPEAKER-disjoint. It requires at least two genuinely distinct
speakers represented across all eight classes (seven words plus UNKNOWN).
If all current recordings came from one speaker, V3 correctly refuses to
train. Collect consented recordings from additional speakers and then rerun:

    .\local-server\train_noise_kws_v3.cmd --init-groups

Existing IDs are preserved; only new files are added as blank rows.

If using exactly one speaker, an explicitly weaker session-disjoint
exploratory analysis is possible, but requires at least two real sessions
per class, including UNKNOWN:

    .\local-server\train_noise_kws_v3.cmd --group-by session --check

This will show speaker_overlap_count and a warning: same-speaker validation
does not demonstrate generalization to previously unseen voices.

## Optional hard negatives

Capture non-emergency *near-miss* phrases and words, e.g. ordinary phrases
that sound remotely like HELP, FIRE or DANGER but NEVER say the actual seven
emergency labels. Obtain speaker consent; disable external notifications for
emergency-word experiments. Start the optional local PCM backend and connect
Camera 1 using the instructions in the parent experiment. Then:

    .\local-server\capture_neural_training_wavs.cmd --label hard_negative --split train --samples 10 --seconds 1.8

These live under train/hard_negative/*.wav and are treated as class UNKNOWN.
Do not put genuine emergency-word speech in the hard-negative directory.
V3 supports zero such files initially; additional negatives strengthen the
dataset, but they need manifest speaker/session annotations too. An actual
misclassified OLD HOLDOUT WAV must NOT be moved into training or copied as a
hard negative: that would contaminate evaluation.

## Validate groups and quality BEFORE starting V3

    .\local-server\train_noise_kws_v3.cmd --check

The command refuses missing or altered files, blank speaker/session IDs,
insufficient speaker groups per label, or any split that cannot preserve
all eight classes in both training and validation. It never guesses or
silently reassigns people between splits.

## Run V3 (isolated)

    .\local-server\train_noise_kws_v3.cmd --epochs 90 --patience 12 --variants 4 --seed 42

Or for an explicitly session-disjoint exploratory run:

    .\local-server\train_noise_kws_v3.cmd --group-by session --epochs 90 --patience 12 --variants 4 --seed 42

The trainer never loads existing V1/V2 model files. It saves:

    local-server/neural-kws-data/artifacts/noise_augmented_shadow_v3.npz
    local-server/neural-kws-data/artifacts/noise_augmented_shadow_v3.report.json

The JSON includes training-only validation recall and negative false
positives, groups/counts, training/validation loss history and best epoch.
The file-level validation diagnostics include FIRE WAV duration and
energy-trimmed duration, helping identify word-onset/word-ending truncation.

DO NOT feed V3 NPZ to the existing neural_kws_trial.py shadow loader:
that loader expects the V1 model format. V3 is OFFLINE research-only pending
separate integration and independent safety evaluation.

For an optional historical comparison, run with:

    .\local-server\train_noise_kws_v3.cmd --exploratory-legacy-holdout

This opt-in evaluates the previously used 31 holdout clips ONLY after
training and early stopping have selected the V3 checkpoint. Do not tune
on the outcome or report it as an unbiased independent test.

## Research-quality validation requirements

1. A truly independent test set collected AFTER model changes, with fresh
   speakers, recording sessions, distances and ambient noises, is necessary.
2. The reported unknown false-positive FRACTION on clips is not false
   alarms per hour. For operational risk, observe long negative streams.
3. Keep actual field speech and noise realistic, and verify spoken labels
   by listening, not by looking at recording duration alone.
4. An energy/Log-Mel feature audit does not validate pronunciation or labels.
5. V3 cannot be promoted automatically into alert/Camera Alert/Event History
   paths. No branch writes deployed DTW templates.
