# V3 read-only speech-window sensitivity study (October 31, 2026)

Branch: experiment/kws-v3-segment-audit-20261031
Parent: experiment/noise-kws-v3-validation-20261031

## Why this experiment

After manually quarantining 40 wrongly labeled WAVs from the original 129,
the operator verified 45 new 2.5-second samples (5 per emergency keyword,
10 UNKNOWN). The V3 grouped run used 89 original training WAVs and 45 new
validation WAVs, all from the same speaker. The validation set was involved in
early stopping and is NOT an independent final test.

Observed original-word training: raw top-class accuracy 67/71 (94.37%),
fixed-gate correct recall 50/71 (70.42%). Validation: raw top-class
accuracy 18/35 (51.43%), fixed-gate recall 11/35 (31.43%), and 0/10
UNKNOWN false positives on a small clip set. V3 is not eligible for alert use.

FIRE validation energy-trimmed duration median was 2.49 s versus 0.47 s
in training, suggesting that the fixed 16-step feature vector might include
substantial non-word audio. This observation does not identify what sound
caused the excess energy. POLICE validation had 3/5 correct raw top-class
hypotheses but 0/5 fixed-gate correct, showing an independent threshold
rejection issue.

## Run without changing model, datasets, or alerts

PowerShell in repo root:

    git fetch origin
    git switch --track origin/experiment/kws-v3-segment-audit-20261031
    .\local-server\diagnose_noise_kws_v3_windows.cmd

If you already have this branch locally, use
\`git switch experiment/kws-v3-segment-audit-20261031\` then
\`git pull --ff-only\`.

The script verifies the saved V3 model/report and group manifest fingerprint.
For the original 45 validation WAVs, it compares their original full-clip
prediction against **three predetermined durations** (0.8, 1.2, and 1.6 s).
Each shortened window is chosen by the highest RMS energy in 50-ms increments
and WITHOUT using the truth label, model output, or acceptance confidence.
The model remains frozen; the original 0.80 acceptance and 0.15 margin remain
unchanged. The operation reads WAVs only and saves a metadata-only report:

    local-server/neural-kws-data/artifacts/noise_augmented_shadow_v3.segmentation-audit.json

View a compact result with per-label counts, with FIRE and POLICE details:

    .\local-server\diagnose_noise_kws_v3_windows.cmd --show-files

In PowerShell:

    $r = Get-Content ".\local-server\neural-kws-data\artifacts\noise_augmented_shadow_v3.segmentation-audit.json" -Raw | ConvertFrom-Json
    $r.metrics.PSObject.Properties | ForEach-Object {
      [PSCustomObject]@{
        method = $_.Name
        raw = $_.Value.raw_top_positive_accuracy
        accepted = $_.Value.fixed_gate_positive_recall
        unknown_false_positives = $_.Value.unknown_false_positive_count
        fire_raw = $_.Value.by_label.fire.raw_correct
        fire_accepted = $_.Value.by_label.fire.gated_correct
        police_raw = $_.Value.by_label.police.raw_correct
        police_accepted = $_.Value.by_label.police.gated_correct
      }
    } | Format-Table -AutoSize

## Interpretation and safeguards

- If predetermined, label-blind audio crops recover FIRE rankings, it
  supports **investigating** a stronger speech localization strategy, not
  immediately switching the production system to the crop method.
- If FIRE stays wrong even when high-energy windows are shortened, missing
  acoustic separation, noisy background, or model capacity still need study.
- A high-energy window is NOT a validated voice activity detector. Fans,
  televisions, impacts or other loud non-speech can dominate its selection.
- Compare UNKNOWN false positives for every crop duration; keyword scanning
  can invent accidental high-confidence alarms.
- This validation set has influenced experiment design and checkpoint
  selection. Do NOT report a winning crop as prospective generalization.
  Collect fresh separate-session, ideally different-speaker audio for an
  independent locked-down final evaluation before promotion.
- No active DTW templates, Zipformer, emergency alerts, enrolled words,
  Event History, live KWS, or stable branch are modified.
- Keep raw WAVs, manifest and diagnostic JSON private and Git-ignored.
