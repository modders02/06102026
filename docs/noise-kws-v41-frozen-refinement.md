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
