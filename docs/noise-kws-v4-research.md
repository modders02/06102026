# MSDS V4: isolated offline temporal CNN research (2026-10-31)

**Branch:** \`experiment/neural-kws-v4-temporal-cnn-20261031\`
**Parent:** \`experiment/noise-kws-v3-validation-20261031\`

**Do not merge or deploy as an emergency alert engine.** V4 does not modify
\`stable_branch_271026\`, manually enrolled DTW templates, the current
sherpa/Zipformer experiment, active keyword detection, Camera Alerts,
Event History or notification logic. New files exclusively.

## Motivation and limits

A human-listening audit quarantined 40 mislabeled WAVs from the original
129 training recordings. The surviving 89 WAVs and 45 newly captured and
individually approved WAVs yield a total of **134** labeled originals.
The corrected V3 (89 old training, 45 new session validation) achieved:
- Original training: 94.37% raw top-class accuracy, 70.42% fixed-gate
  positive recall.
- New session validation: 51.43% raw top-class accuracy (18/35),
  31.43% fixed-gate positive recall (11/35), 0/10 UNKNOWN false positives.
- FIRE: 1/5 accepted. POLICE: 0/5 accepted.
- 0.8-second max-RMS cropping raised raw accuracy to 62.86% but did not
  improve fixed-gate positive recall; the same FIRE and POLICE failed.

This session was recorded with the **same speaker**, used for V3 early
stopping and subsequent experiment design. V4 uses it again for checkpoint
selection. **It cannot establish independent generalization or unbiased
accuracy.** Any V4-vs-V3 result is exploratory, not prospective evidence.

## What V4 actually implements

1. Label-blind, waveform-only **acoustic candidate localization**: 25 ms RMS
   frames, 10 ms hop, 20th/90th percentile contrast, short-gap merging,
   padded energy-region selection and a 1.6-second cap for long regions.
   The cap uses waveform energy and envelope modulation only, never the
   model's output, true label or acceptance confidence. **This is not a
   validated speech VAD** and can select fan noise, impacts or TV speech.
2. A small **learned temporal convolution** model in NumPy:
   - Input: ordered 48 x 32 Log-Mel features via a feature-only copy of
     the existing acoustic extractor.
   - 24 filters, five-frame (5 x 32) convolution, ReLU.
   - 1+2+4 temporal pyramid pooling to retain coarse phoneme ordering.
   - Eight-class softmax (seven emergency keywords plus UNKNOWN).
   - Class-balanced minibatches, L2, dropout, gradient clipping, Adam,
     group-disjoint early stopping.
3. Train-only noise/echo augmentations and synthetic noise negatives.
   **No validation augmentations**, heldout WAVs or training data
   normalization derived from validation.
4. Raw top-ranked classification is reported **separately** from the
   original reference acceptance gate (top probability >=0.80,
   first-to-second margin >=0.15). These thresholds are NOT calibrated for
   V4 and should not be relaxed using the current validation clips.
5. Separate new artifact \`artifacts/noise_temporal_cnn_v4.npz\` and
   \`noise_temporal_cnn_v4.report.json\`. They are incompatible with existing
   V1/V3 shadow loaders and cannot be wired into alerts.

V4 is a genuine trainable CNN implemented with NumPy, not a pretrained
language model or a deployed speaker-independent KWS model. Improvements
are **not guaranteed**; it is possible this model will overfit as well.

## 1. On Windows, check your local dataset

In a clean PowerShell terminal from the repository root:

    cd "C:\Users\nazar\Documents\ongoin\06102026-kws"
    git status
    git fetch origin
    git switch --track origin/experiment/neural-kws-v4-temporal-cnn-20261031
    .\local-server\train_noise_kws_v4.cmd --group-by session --check

If the local branch already exists, use \`git switch
experiment/neural-kws-v4-temporal-cnn-20261031\` and \`git pull --ff-only\`.

The check does not train or create an NPZ. It should show **89 training** and
**45 session validation** original WAVs and should report a single speaker
overlapping train/validation. The audio audit must show zero feature errors.

If the manifest was moved, labels were changed or a WAV's checksum differs,
stop and inspect rather than modifying metadata to force a pass.

## 2. Train V4 offline

    .\local-server\train_noise_kws_v4.cmd --group-by session --epochs 65 --patience 10 --variants 3 --seed 42

Default train vectors: (89 original + 267 augmented) + 9
noise-only negatives = **365**. Validation: **45 untouched original WAVs**.

The standalone trainer refuses to overwrite an existing V4 artifact unless
\`--overwrite\` is explicitly passed. Back up any previous V4 NPZ and JSON
first; never erase the V3 model/report. The code uses only the local
\`local-server/.neural-kws-venv\` Python environment and NumPy installed
by the existing neural KWS experiment. No audio upload.

### View the report

    $p = ".\local-server\neural-kws-data\artifacts\noise_temporal_cnn_v4.report.json"
    $r = Get-Content $p -Raw | ConvertFrom-Json
    $r.training | Select-Object best_epoch,epochs_ran,best_validation_macro_loss,early_stopped | Format-List
    $r.session_validation | Select-Object raw_top_positive_accuracy,fixed_gate_positive_recall,unknown_false_positive_count,unknown_false_positive_fraction,decision_reasons | Format-List
    $r.session_validation.per_label | Format-List

Interpret per-class raw ranking vs fixed gate; do not report 0 false positives
on 10 UNKNOWN clips as a false-alarm-per-hour estimate.

## 3. After freezing V4: fresh independent test recordings

Collect **NEW**, consented, manually playback-verified recordings, after the
architecture and selected model are frozen, preferably from multiple **new
speakers**, sessions, distances and noise conditions. Disable any real
external emergency notification while deliberately speaking distress
keywords. The tool cannot prove independence just from a file timestamp.

Use a unique private path under the Git-ignored \`neural-kws-data\` root,
such as:

    $fresh = "C:\Users\nazar\Documents\ongoin\06102026-kws\local-server\neural-kws-data\independent-v4-test-20261101"

With the Camera 1 PCM feed enabled and neural shadow listener stopped,
capture each class separately. For example:

    .\local-server\capture_neural_training_wavs.cmd --label fire --split train --samples 1 --seconds 2.5 --data "$fresh"

The recording directory layout is \`$fresh\train\<label>\*.wav\`. Repeat
for **help, fire, emergency, danger, intruder, police, ambulance, unknown**,
individually playing and verifying every WAV. Prefer several independent
speakers and at least five positive clips per class and 20-30 UNKNOWN
non-emergency phrases/noises for an initial exploratory test; the evaluator
accepts smaller class counts but they offer very weak estimates.

Once all eight folders have verified recordings, evaluate the *FROZEN* model:

    .\local-server\evaluate_noise_kws_v4.cmd --test-data "$fresh"

The evaluator rejects exact original-training WAV duplicates, disallows
using the existing training/holdout/staging directories, and reads the
new data without retraining or choosing a checkpoint. It saves:

    local-server/neural-kws-data/artifacts/noise_temporal_cnn_v4.independent-evaluation.json

These results are only independent if you actually followed the collection
protocol (new recording event and independent speaker/session provenance).
Programmatic checks cannot confirm pronunciation or human identity.

## Safety and privacy

- No V4 code is imported by \`electron/\`, operational camera routes,
  active alerting, or manually enrolled DTW logic.
- V4 \`--check\` reads research data and features; training only writes
  \`noise_temporal_cnn_v4.npz\` and \`.report.json\` in Git-ignored artifacts.
- Source WAVs, original 134-file private manifest, and future test recordings
  remain local and Git ignored. Do not upload the voice data to GitHub.
- If V4 performs poorly, preserve the report. Do not lower production
  thresholds or promote the candidate into safety decisions.
