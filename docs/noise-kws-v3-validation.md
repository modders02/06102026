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


## When V3 stops at epoch 1 or rejects every validation keyword

For example, session validation may yield raw training loss falling from ~1.61
to ~0.19 while validation macro cross-entropy rises from ~3.15 to ~5.47,
with the best checkpoint at epoch 1 and 0/35 keywords accepted. A reported
0/10 unknown false positives in this situation is NOT evidence of accuracy:
the model predicts UNKNOWN for all 45 evaluation examples.

Do NOT rerun for more epochs, lower acceptance threshold, or promote to alerts.
Investigate whether the raw classifier actually recognizes words before the
fixed 0.80/0.15 acceptance gate, and whether the microphone/room conditions
changed between sessions. The saved V3 model can be diagnosed without
retraining or accessing the previously used 31 legacy holdout WAVs:

    git pull --ff-only origin experiment/noise-kws-v3-validation-20261031
    .\local-server\diagnose_noise_kws_v3.cmd

Optional per-file labels, probabilities, reasons, and trimmed durations:

    .\local-server\diagnose_noise_kws_v3.cmd --show-files

Local report:

    local-server/neural-kws-data/artifacts/noise_augmented_shadow_v3.diagnostic.json

Inspect summary.training versus summary.validation:
- raw_top_positive_accuracy: how often the top-scoring class matches the
  spoken word BEFORE safety gating (NOT alert recall).
- fixed_gate_positive_recall: recognized accepted words with safety gating.
- decision_reasons: top_class_unknown, below_fixed_threshold,
  below_fixed_margin or accepted.
- per_label: confusion plus per-word RMS and post-energy-trim duration.
- fire_validation: all five FIRE session-validation WAVs with top-three
  predicted labels and acoustic metadata.
- validation_errors: error-specific rows; no raw audio is copied.

If raw-top accuracy is near zero, threshold relaxation would be actively
misleading; investigate word content, feature separation and session audio
characteristics. If raw-top is high but gated recall low, the ranking is
often correct but confidence is unreliable; still do not tune the threshold
using the same validation data without new prospective evaluation. Near-0
unknown false-positive rate from always rejecting is not useful.
The script verifies that the saved training split matches the current
manifest and refuses mismatched splits.

All output remains private, and metadata may include local WAV filenames.
Never commit this JSON, private CSV, or source WAVs.


## V3 failure review after the first one-speaker session split

Observed offline: raw 43/74 correct keyword hypotheses on original
training WAVs (58.11%), but only 1/35 on separate session validation
WAVs (2.86%). With the fixed acceptance gate: 4/74 training words
(5.41%) and 0/35 validation words accepted. The five FIRE validation
WAVs had zero correct raw top-word hypotheses. The best epoch was 1:
the session shift is severe, and adding more training epochs is not
a defensible fix.

The read-only diagnostic also reports observational session acoustic
signatures: median total RMS, first/middle/last 300-ms RMS, RMS dynamic
range, near-clipped sample fraction, log-Mel vector mean/standard
deviation, energy-trimmed duration and feature distance to the saved
training-augmentation mean. They are proxies: no automatic check
determines whether the human actually said the expected word.

    git pull --ff-only origin experiment/noise-kws-v3-validation-20261031
    .\local-server\diagnose_noise_kws_v3.cmd

The metadata-only report contains acoustic_session_comparison with
train_medians, validation_medians and per_label comparisons. In
PowerShell:

    $r = Get-Content ".\local-server\neural-kws-data\artifacts\noise_augmented_shadow_v3.diagnostic.json" -Raw | ConvertFrom-Json
    $r.acoustic_session_comparison | Select-Object validation_to_training_median_rms_ratio
    $r.acoustic_session_comparison.train_medians
    $r.acoustic_session_comparison.validation_medians
    $r.acoustic_session_comparison.per_label.fire

Manually listen to representative local WAVs from BOTH sessions
before inferring a signal-processing fix. Windows PowerShell example
(run locally, don't upload raw voice data):

    $root = ".\local-server\neural-kws-data"
    $old = Join-Path $root "train\fire\20261031T021504Z-271c4c28635c.wav"
    $new = Join-Path $root "train\fire\20261031T042028Z-612ea7af4765.wav"
    $player = New-Object System.Media.SoundPlayer
    $player.SoundLocation = (Resolve-Path $old).Path
    $player.PlaySync()
    $player.SoundLocation = (Resolve-Path $new).Path
    $player.PlaySync()

Listen for the correct utterance, clipping, delayed onset, microphone
dropouts, and fan/TV/room noise across the sessions. If speech is not
audibly clear, review capture-timing and microphone placement before
any feature or model changes. Do not relabel an unverified file,
lower the emergency acceptance threshold or move prior holdouts into
training. Keep stable DTW and production alert pathways untouched.
