# MSDS V5: pretrained English Zipformer keyword spotting, offline benchmark

## Why this experiment

The small local NumPy networks are not recognizing emergency words reliably.
V4.1 accepted just 4 of 35 newly recorded emergency keyword samples (11.43%
recall); all four were FIRE. Six other classes had zero accepted detections.
The original 89 train WAVs and the 45 development WAVs also shared a speaker.

This V5 experiment reuses the existing much larger, pretrained English
sherpa-onnx Zipformer keyword spotter already present in the MSDS research
codebase. It keeps exactly seven English keywords and the pre-existing
Sherpa settings: keyword score 1.0, threshold 0.50, two trailing blanks,
CPU. Unlike V4, it does not crop a WAV. The fixed 0.8-second zero tail
allows the streaming transducer to flush its final keyword evidence.

No V5 training, operational KWS replacement, or parameter tuning is
performed. This is an offline research benchmark.

## Windows PowerShell

At the existing project root:

    cd "C:\Users\nazar\Documents\ongoin\06102026-kws"
    git fetch origin
    git switch --track origin/experiment/kws-v5-pretrained-zipformer-benchmark-20261031
    $testData = Join-Path (Get-Location).Path "local-server\neural-kws-data\independent-v41-test-20261101"
    .\local-server\benchmark_sherpa_kws_v5.cmd --test-data "$testData" --check
    .\local-server\benchmark_sherpa_kws_v5.cmd --test-data "$testData"

The CMD wrapper changes working directory; use an ABSOLUTE test path.
The check confirms pretrained model and keyword files, manifest SHA
disjointness and 55 distinct WAVs without decoding or writing.
If setup is missing, follow the printed error; do not download an
unverified model. The existing isolated venv must have sherpa-onnx.

## Metrics and artifacts

Each WAV uses a new Sherpa stream. All events are counted, rather than
selecting the best detected word after seeing the true label.
A correct positive WAV must contain at least one expected keyword event
and no wrong-word event; any event on UNKNOWN is a false positive.
The report contains per-label recall, first-event confusion,
multi-event diagnostics, metadata SHA hashes and evaluation signature.

Private report (refuses overwrite):

    local-server/neural-kws-data/artifacts/sherpa_zipformer_v5.offline-benchmark.json

No WAV copies, uploads, retraining, threshold changes, camera connection,
enrollment-store operations, Event History or active emergency alerts.

## Mandatory limits

The 55-WAV set was already tested on V4.1. This is an EXPLORATORY
pretrained benchmark, not an unbiased final evaluation.
Consent, manual label accuracy and speaker/session independence must be
verified by the researcher, not inferred from directory names.

Before any future deployment, freeze model/keywords/thresholds, collect
a NEW sealed multi-speaker test set, and predefine safety criteria.
An initial engineering target is at least 90% recall PER keyword plus
a pre-agreed false-alarm budget per continuous audio hour; evaluate
quiet/noisy speech, TV sounds, hard-negative phrases, far-field distance,
latency, CPU and CCTV/audio connection failure recovery. No candidate
should control emergency alerts until all safety criteria are met.

Preserve stable_branch_271026, active DTW enrollments, and all historical
V3/V4/V4.1 research models. Do not access the legacy 31-WAV holdout.
