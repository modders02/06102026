# MSDS V4 speech context-preservation study (2026-10-31)

New branch: \`experiment/kws-v4-context-preservation-audit-20261031\`
Based on \`experiment/kws-v4-crop-playback-audit-20261031\`.

## Human-listening findings

After 40 corrupted labels were quarantined and 45 new WAVs were reviewed,
V4's same-speaker session-separated validation had only 7/35 accepted
emergency words (20%). The human original-versus-crop audit found:

| Word | Complete cropped words | Missing/clipped/incorrect crops | V4 accepted |
| --- | ---: | ---: | ---: |
| EMERGENCY | 0/5 | 5/5 | 0/5 |
| INTRUDER | 4/5 | 1/5 | 0/5 |
| FIRE | 2/5 | 3/5 | 2/5 |

The cropping stage clearly discards part of some utterances. However, four
correctly preserved INTRUDER crops are still misclassified, so cropping is
**not** the entire classifier failure.

## What this research script does

Only the **9 recordings marked N** in the first listening audit are played
again. It starts from the exact prior V4 crop boundaries and expands each
side by a **fixed 0.55 seconds**, clipped to the original 2.5-second WAV.
The duration is a fixed exploratory choice, *not* fit to prediction scores
or keyword labels. This strategy cannot add missing information if it
falls more than 0.55 seconds outside the original crop.

The script reads and rechecks the saved V4 research checkpoint, report
metadata, training/validation fingerprints, original review CSV and the
WAV content SHA hashes before playback. The original WAV and the
expanded crop are played synchronously **in memory only** using Windows
\`winsound.SND_MEMORY\`. No raw audio is copied or saved.

The user grades each wider crop as:
- \`Y\`: Contains the entire correct expected keyword clearly.
- \`N\`: Still incomplete, missing syllables, incorrect segment/sound.
- \`U\`: Uncertain.
- \`R\`: Replay both clips.
- \`Q\`: Stop safely; existing votes are saved.

The experiment does **not** retrain V4, apply the original V4 model to
alternate segments, change confidence thresholds, update enrolled DTW
templates, modify alerts, or access the legacy holdout. It is not an
independent generalization test.

## Windows PowerShell

From the project root:

    cd "C:\Users\nazar\Documents\ongoin\06102026-kws"
    git fetch origin
    git switch --track origin/experiment/kws-v4-context-preservation-audit-20261031
    .\local-server\audit_noise_kws_v4_context.cmd

When a local branch with that name already exists:

    git switch experiment/kws-v4-context-preservation-audit-20261031
    git pull --ff-only

Output metadata is private and Git-ignored:

    local-server/neural-kws-data/artifacts/noise_temporal_cnn_v4.context-review.csv

The summary presents Y/N/U counts per word for the nine original failures.

## How to interpret

If most of these nine previously incomplete crops become Y, this supports
a separate future *conservative context-preserving localization* experiment.
That preprocessing must be applied uniformly to all eight classes during
training and prospective evaluation. It is NOT correct to use reviewer
labels to choose crop length at prediction time, choose preprocessing
per keyword, or claim improved validation accuracy on these reused WAVs.

If many remain N, the original energy candidate itself likely missed too
much of the word, and simply adding context is inadequate. Study multi-
region localization or a non-destructive full-clip control.

Regardless of these results, the four intact but missed INTRUDER clips
require separate acoustic representation/data-diversity investigation.

To establish research credibility, freeze the algorithm/model and collect
fresh recordings from independent speakers/sessions without using this
already-reviewed validation set for another final estimate.

The stable branch, V3/V4 original NPZ files, live KWS, Event History, and
emergency alert routing are not changed.
