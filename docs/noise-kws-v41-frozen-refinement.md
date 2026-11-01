# MSDS V4.1 refinement: frozen CNN failure analysis

**Branch:** experiment/kws-v41-frozen-refinement-20261101
**Parent:** experiment/kws-v41-context-preserving-train-20261031

## Why V4.1 rather than V3?

On the same previously collected 55-WAV set:

| Candidate | Correct top keyword | Correctly accepted | UNKNOWN false-positive clips |
|---|---:|---:|---:|
| V3 frozen MLP | 7/35 | 4/35 | 0/20 |
| V4.1 context-preserving CNN | 16/35 | 4/35 | 0/20 |
| V5 pretrained Sherpa | n/a (event-based) | 3/35 | 0/20 |

V4.1 has the better raw classification among the original CNN/MLP
candidates on the same recordings; this does NOT establish useful
operational sensitivity. It needs diagnosis before retraining.

The original V4.1 architecture +0.55-second context and fixed confidence
threshold 0.80 / margin 0.15 remain UNCHANGED.

## What this branch adds

A read-only failure analyst categorizes every original per-file result
in the SAVED V4.1 evaluation report. It does not re-run model inference,
change confidence thresholds, resample recordings, train a new model,
open CCTV feeds, publish alerts or alter enrollment templates.

- Correct top keyword and accepted
- Correct top keyword but blocked by original confidence/margin gate
- Wrong top keyword (a classifier failure, not a threshold issue)
- Any wrong accepted keyword (especially safety-critical)
- Any UNKNOWN word falsely accepted as an emergency
- Per-label raw/accepted/rejected counts and gate-reason distribution

It validates the model variant and its original metadata, makes sure
the saved report matches the frozen candidate's creation time/version,
checks per-file score and class consistency, and rejects mismatched
aggregate metrics. The output is a private write-once diagnostic JSON.
It will NOT overwrite any previous diagnostic.

The report is already known to be exploratory: these 55 recordings
have now been reused for V4.1, V5 and V3. Do not change the model or
threshold to maximize performance on this cohort and then call the
same cohort an independent final test. Manual label quality and actual
speaker/session independence remain unverified.

## PowerShell

From project root:

    cd "C:\Users\nazar\Documents\ongoin\06102026-kws"
    git status --short
    git fetch origin
    git switch --track origin/experiment/kws-v41-frozen-refinement-20261101

If branch is already local, switch to it and run git pull --ff-only.
Do not use hard reset or git clean; private WAV and venv files are local.

Read-only preview:

    .\local-server\audit_noise_kws_v41_failures.cmd --check

Save one local diagnostic:

    .\local-server\audit_noise_kws_v41_failures.cmd

Writes under the Git-ignored neural-kws-data/artifacts directory:

    noise_temporal_context_v41.failure-audit.json

The input must already exist from the earlier evaluation:

    noise_temporal_context_v41.independent-evaluation.json
    noise_temporal_context_v41.npz

If the report is absent, the auditor stops. Do not retrain or overwrite
the checkpoint. Preserve the prior original report as research evidence.

## Future V4.1 improvements

The immediate goal is to locate **which exact acoustic or classification
failures** dominate (not merely lower thresholds). Next, collect and
manually label additional, consenting speaker-disjoint training and
development data, develop a separate candidate filename and freeze
all choices before evaluating a NEW unseen group. We also need continuous
background audio false-alarm/hour, long-term camera-audio reliability,
far-field sensitivity and per-class emergency recall.

Do not integrate V4.1 into real alert routing unless prospective
operational acceptance criteria are met. stable_branch_271026, production
manual-DTW templates, Camera Alerts, Event History and notifications
stay untouched.


## Next: review the 19 incorrect raw predictions by listening

The observed error distribution is not just the safety gate: EMERGENCY
was incorrectly classified in **5/5** recordings, AMBULANCE in 4/5,
INTRUDER and POLICE in 3/5 each, HELP and DANGER in 2/5 each.
All 12 correct-but-rejected positive predictions failed the original
0.80 threshold (not the 0.15 margin), but five UNKNOWN recordings
also ranked an emergency word highest before the fixed gate rejected
them. Do NOT loosen thresholds on this already-studied cohort.

We must distinguish an **audible complete expected word** from
a **wrong/missing/truncated V4.1-selected segment**, and both from
a genuine classifier failure. The following tool plays audio locally
on Windows using winsound memory buffers. It NEVER writes new WAVs
or changes the source/model. It writes only a Git-ignored CSV of
operator judgments, keyed by SHA256 to prevent stale review reuse.

    $testData = Join-Path (Get-Location).Path "local-server\neural-kws-data\independent-v41-test-20261101"
    .\local-server\audit_noise_kws_v41_playback.cmd --test-data "$testData" --group wrong-top --check
    .\local-server\audit_noise_kws_v41_playback.cmd --test-data "$testData" --group wrong-top

For each of 19 recordings, the tool plays the ORIGINAL and the V4.1
selected audio. Confirm what is actually heard:
- Original expected word audibly complete? Y/N/U
- V4.1 segment retains the COMPLETE expected word? Y/N/U
- Audio clarity C=clear, S=soft, N=noisy/distorted, U=uncertain
- R replays both clips; Q quits, keeping previously saved reviews.
  Run the same command again to resume without duplicate review rows.

Also audit the 12 correctly ranked but gate-rejected examples and the
five UNKNOWN files whose raw top classes were emergency words:

    .\local-server\audit_noise_kws_v41_playback.cmd --test-data "$testData" --group correct-rejected
    .\local-server\audit_noise_kws_v41_playback.cmd --test-data "$testData" --group unknown-suspicious

For UNKNOWN, Y in either spoken-word question means any of the
seven emergency keywords was audible, not that the label is correct.
A separate accepted-control group reviews the four correctly accepted
positive recordings. The "all" group may review the complete 55.

Private CSV location:

    local-server\neural-kws-data\artifacts\noise_temporal_context_v41.manual-audio-review.csv

Interpret human results conservatively. A full, clear expected word
preserved in the selected audio but still incorrectly ranked suggests
a genuine model/domain-generalization failure. If the full recording
does not contain the expected word, fix the training/development
collection protocol separately; never relabel this 55-WAV test set
and reuse it for an unbiased final claim. If V4.1 truncates the word,
investigate localization on NEW development recordings, freeze any
changes, and evaluate a NEW sealed multi-speaker test set.

This is experimental diagnostics only; no deployment from this outcome.


## Update after UNKNOWN-suspicious review: potential dataset contamination

The 5 of 20 originally UNKNOWN-labeled clips whose raw classifier top-1
was an emergency keyword were **ALL marked Y** by the operator for an
audible emergency keyword in the ORIGINAL full WAV. Four of the five
V4.1 selected-segment answers were marked Y; the fifth was accidentally
saved EMPTY because Python's empty string is a substring of any string.
This is a review UI bug; its missing answer MUST NOT be inferred to be Y.

**Therefore, if UNKNOWN means no emergency keyword present, those five
negative class labels are not trustworthy.** They may be mislabeled, or
may contain emergency words in a sentence with context; an independent
reviewer should note exactly WHICH keyword and semantic context was
heard. Do not silently move files to positive train classes or alter
original evaluation data. The other 15 UNKNOWN files have not yet
received complete manual content review. Previously published 0/20
negative false positive figures are only a reflection of folder labels,
not validated background false-alarm performance.

The current branch FIXES the empty input acceptance bug, refusing empty
or multi-letter input and rejecting incomplete existing review CSVs.
It provides an EXPLICIT opt-in interactive repair that replays just
those WAVs with blank saved judgments. The original CSV is preserved
as a byte-for-byte timestamped .bak file, and all nonblank values are
kept intact. No raw WAV, class label, model or threshold is changed.

PowerShell, after git pull --ff-only:

    $testData = Join-Path (Get-Location).Path "local-server\neural-kws-data\independent-v41-test-20261101"
    .\local-server\audit_noise_kws_v41_playback.cmd --test-data "$testData" --repair-invalid-review

Listen and explicitly answer the replay question. If uncertain, enter
U (not an empty line), or Q to abort without modifying the CSV.

Next, review all 20 UNKNOWN WAVs, skipping the five already reviewed:

    .\local-server\audit_noise_kws_v41_playback.cmd --test-data "$testData" --group unknown-all

This may expose additional contaminated labels and can no longer be
called a sealed final test. Record which spoken words actually occurred,
using a separate human review log; do not retrain or tune on this
reviewed cohort. Collect verified new negatives and positives from
different consenting speakers and test sessions before model selection.
