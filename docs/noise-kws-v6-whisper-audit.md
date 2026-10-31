# MSDS V6 — offline full-clip Whisper ASR audit (research only)

## Why this exists

The new 55-WAV CCTV dataset (35 expected emergency-word recordings, 20
UNKNOWN recordings) was already used to test two candidate models:

| Candidate | Accepted emergency recall | UNKNOWN false positives |
| --- | --- | --- |
| V4.1 context CNN | 4/35 (11.43%), all FIRE | 0/20 |
| V5 pretrained Sherpa Zipformer | 3/35 (8.57%): 2 EMERGENCY, 1 DANGER | 0/20 |

Neither model is adequate for safety-critical emergency detection.
Zero false positives across just 20 short negative clips does not establish
reliability in live CCTV monitoring.

The next controlled diagnostic question is whether a **different pretrained
speech-recognition architecture** can transcribe the ENTIRE 2.5-second
recording as English text, rather than rely on a custom small CNN or
a streaming keyword detector. This is a **frozen** CPU inference baseline:

- CTranslate2/faster-whisper **base.en**, CPU, int8, beam 5, English forced,
  greedy temperature 0, no VAD or prompting, no language-specific adaptation.
- All original WAVs evaluated without cropping, denoising, augmentation,
  resampling or retraining. Audio must be complete 16-kHz mono PCM16.
- Keyword detection from EXACT whole word matches only: help, fire,
  emergency, danger, intruder, police, ambulance. 'firefighter' is NOT
  'fire', 'helpful' is NOT 'help'. No fuzzy, phonetic or label-based guesses.
- True positive clip has one or more expected emergency words and ZERO
  incorrect emergency words in transcript. UNKNOWN with ANY detected
  emergency keyword is a false-positive clip.
- Full decoded transcript, waveform RMS/peaks/boundary RMS, per-label
  metrics and fingerprint saved privately. Audio text can contain
  personally sensitive speech; do NOT commit/share this JSON unredacted.

No existing MSDS production, notifications, Camera Alerts, Event History,
manual enrollment DTW templates, models V3/V4/V4.1/V5, or the stable
branch are modified.

## Windows PowerShell instructions

From the repo root:

    git fetch origin
    git switch --track origin/experiment/kws-v6-whisper-asr-audit-20261031

If already checked out, switch normally and git pull --ff-only.
Always run commands in the project root (CMD wrappers change directory).

Install optional ASR dependencies into a NEW isolated environment
(local-server/.kws-v6-venv), not the operational .venv or previously
installed .neural-kws-venv:

    .\local-server\setup_whisper_kws_v6.cmd

This explicitly installs the third-party pip packages from PyPI.
It does **not** download model weights automatically. The isolated
environment uses faster-whisper 1.2.1 and NumPy 1.26+.

Set test directory using an absolute path:

    $testData = Join-Path (Get-Location).Path "local-server\neural-kws-data\independent-v41-test-20261101"

Check all 55 WAVs, their SHA256 duplicates, and acoustic-level summaries:

    .\local-server\benchmark_whisper_kws_v6.cmd --test-data "$testData" --check

The check needs no Whisper model weights or network. If it reports
missing/near-silent/clipped WAVs, do not assume they contain correct words;
manually listen and document the underlying problem. File metrics alone
cannot establish spoken content or informed consent.

The first ASR run needs the external pretrained model downloaded to the
existing Git-ignored local neural-kws-models area, unless it was already
cached. To EXPLICITLY authorize this one download:

    .\local-server\benchmark_whisper_kws_v6.cmd --test-data "$testData" --allow-download

Later, after the model is cached locally, omit --allow-download:

    .\local-server\benchmark_whisper_kws_v6.cmd --test-data "$testData"

Note: The report is write-once. A completed previous benchmark will
refuse to overwrite. If the first run aborts midway, no report is written.
The report is saved at:

    local-server/neural-kws-data/artifacts/whisper_base_en_v6.offline-benchmark.json

The model may consume substantial RAM and CPU time on old processors.
Do not start live emergency alert tests while deliberately speaking
emergency words for dataset collection.

## Research limitations and next decision

Do NOT claim an unbiased V6 independent score. These SAME 55 WAVs
were previously examined under V4.1 and V5, so treating V6 as a
candidate selected by their results introduces model-selection bias.
The group-training manifest and SHA checks detect exact WAV duplicates,
NOT overlapping voices, rooms, or repeated utterances. Explicit manual
speaker/session/label confirmation is still required.

The full decoded transcripts offer a way to audit whether a case
contains the correct word. Some short clips can be hallucinated or
mis-transcribed. Do not lower thresholds or tune prompts on this set.

Before ANY operational integration:
1. Freeze the candidate model and text parsing, plus acceptable latency.
2. Recruit additional consenting, new speakers and verify WAV labels.
3. Use a genuinely new sealed set and continuous CCTV audio from
   quiet/noisy, far/near and TV/background conditions.
4. Set per-class recall and false alarm/hour targets in advance. An
   initial engineering target of >=90% recall for each emergency word
   is not a safety guarantee and needs application-specific validation.
5. Keep production DTW, KWS, camera alert and notification settings
   unchanged unless a candidate meets these criteria.

This experiment is NOT an operational implementation or safety signoff.
