# MSDS neural KWS V4.1 — uniform context-preserving *research-only* retraining

Branch: \`experiment/kws-v41-context-preserving-train-20261031\`
Parent: \`experiment/kws-v4-context-preservation-audit-20261031\`

This is a NEW offline research candidate, not an MSDS production update.

## Evidence from operator playback

The operator listened to ORIGINAL and V4 CROPPED WAVs for the 15 most
important development-validation recordings:

| Label | Complete original V4 crops | Incomplete V4 crops |
|---|---:|---:|
| EMERGENCY | 0/5 | 5/5 |
| FIRE | 2/5 | 3/5 |
| INTRUDER | 4/5 | 1/5 |

A separate read-only replay expanded only the **nine** incomplete clips
by a predetermined +0.55 seconds of audio on either side. Eight of nine
became complete (EMERGENCY 5/5, FIRE 2/3, INTRUDER 1/1).
Together, 14 of these 15 context-preserved crops were audibly complete.
That confirms the V4 acoustic region selection was often too aggressive.
It does not establish that a wider crop improves neural classification.
Four completely audible INTRUDER crops still failed V4.

## One controlled change from V4

**Use the identical fixed +/-0.55s context expansion for EVERY WAV:**

- all seven emergency classes; every UNKNOWN original
- all 89 training source WAVs and any augmented variants
- all train-only synthesized negative noise examples
- all 45 separate-session development validation WAVs
- any future fresh independent evaluation WAVs.

No per-word, per-file, model-confidence, or manually audited Y/N override is
used for feature extraction. The cropped waveform never alters the original
WAV. The original V4 energy-contrast localizer still proposes the center
region. Its boundaries are expanded by fixed 0.55-second context and
clipped to the original recording length. All clips then pass into the SAME
48 x 32 ordered Log-Mel, 24-channel five-frame temporal CNN and 1/2/4
temporal pyramid pooling as V4. The same frozen 0.80 reference threshold
and 0.15 probability margin are used only for OFFLINE scoring.

The ±0.55s expansion was **selected after reviewing V4 validation errors**.
Thus the same 45 recordings are contaminated for final model comparison
and were also used for early-stopping. Any V4.1 performance result on
these recordings is exploratory/selection-biased and must NOT be claimed
as independent generalization, improvement on new people, or readiness
for emergency alert use.

V3 and V4 artifact names remain unchanged. New files:
\`local-server/neural-kws-data/artifacts/noise_temporal_context_v41.npz\`
and \`noise_temporal_context_v41.report.json\`.
The output is a separate research-only NumPy checkpoint, never loaded
by the live application.

## Run V4.1 on Windows

In PowerShell from the repo root:

    cd "C:\Users\nazar\Documents\ongoin\06102026-kws"
    git status
    git fetch origin
    git switch --track origin/experiment/kws-v41-context-preserving-train-20261031
    .\local-server\train_noise_kws_v41.cmd --group-by session --check

For an existing local branch, use \`git switch
experiment/kws-v41-context-preserving-train-20261031\` then
\`git pull --ff-only\`.

The check validates all 134 original WAVs, the private manifest and
feature extraction. Expect 89 training and 45 validation originals;
the same speaker in both groups is explicitly reported.

Train the new separate V4.1 model:

    .\local-server\train_noise_kws_v41.cmd --group-by session --epochs 65 --patience 10 --variants 3 --seed 42

Train matrix expectation: 89 original + 267 augmented + 9 synthetic
noise negatives = **365** sequences. Validation stays 45 unaugmented,
session-separated original recordings (35 positives + 10 unknown).

The command refuses to overwrite an existing V4.1 artifact. If
retraining is necessary, first back up the V4.1 NPZ and JSON, then
explicitly pass \`--overwrite\`. Do not erase V3 or V4 files.

To summarize V4.1:

    $base = ".\local-server\neural-kws-data\artifacts"
    $r = Get-Content "$base\noise_temporal_context_v41.report.json" -Raw | ConvertFrom-Json
    $r.training | Select-Object best_epoch, epochs_ran, best_validation_macro_loss, early_stopped | Format-List
    $r.session_validation | Select-Object raw_top_positive_accuracy, fixed_gate_positive_recall, unknown_false_positive_count | Format-List
    $r.session_validation.per_label.PSObject.Properties | ForEach-Object {
      [PSCustomObject]@{
        Label = $_.Name
        RawCorrect = $_.Value.raw_correct
        Accepted = $_.Value.accepted_correct
        Total = $_.Value.count
      }
    } | Format-Table -AutoSize

For comparison on the same *development* validation set:
- V3 raw 18/35, accepted 11/35; 0/10 UNKNOWN false positives.
- V4 raw 15/35, accepted 7/35; 0/10 UNKNOWN false positives.

Both remain unsuitable for operational emergency alerts.

## Future independent test, after freezing V4.1

Collect new manual-reviewed WAVs in a brand-new, separate Git-ignored
\`neural-kws-data\` subdirectory, such as \`independent-v41-test-20261101\`,
using a different consenting speaker and separate session. Include
all 8 classes in \`train/<label>/*.wav\` under that test directory.
At least 5 positives per class and a substantially larger UNKNOWN
sample are useful as an exploratory start; a deployability evaluation
requires much more diverse multi-speaker and continuous-noise testing.

When the candidate and preprocessing are frozen:

    .\local-server\evaluate_noise_kws_v41.cmd --test-data "C:\Users\nazar\Documents\ongoin\06102026-kws\local-server\neural-kws-data\independent-v41-test-20261101"

The evaluator rejects original train-file SHA256 duplicates and
training/legacy-holdout directory reuse, and checks the V4.1 model
variant. It applies V4.1 preprocessing consistently to fresh audio.
Exact-file checks **cannot verify speaker/session independence**; the
researcher must document it. Testing should avoid triggering live
emergency notifications.

## Operational isolation

- No changes to \`stable_branch_271026\`, active manually enrolled DTW
  templates, original V3/V4 neural research models, CCTV reconnect,
  Camera Alerts, Event History, live KWS, or notification routing.
- Local WAVs, reviewed CSVs, manifest, V4/V4.1 artifacts and private
  evaluation remain under the existing Git-ignored data directory.
- No tuning of acceptance thresholds on this repeatedly reused
  development-validation session.
- If V4.1 has lower recall, preserve the failure report and investigate
  a nondestructive full-clip control or data diversity before trying a
  bigger CNN.
