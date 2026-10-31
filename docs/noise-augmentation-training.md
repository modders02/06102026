# MSDS Stage 2 — Noise-augmented English wake-word training

Experimental branch: experiment/noise-augment-training-20261031
Parent branch: experiment/noise-robust-neural-kws-20261030

This trains a SEPARATE small NumPy MLP on real labeled CCTV speech,
plus randomized noise and simplified room echo. It does NOT fine-tune the
pretrained sherpa-onnx Zipformer and does NOT change the active DTW engine,
stored enrollment templates, Event History, or Camera Alerts.

## 1. Start experimental MSDS

First stop the OLD local MSDS camera server and desktop app, then:

    cd "C:\Users\nazar\Documents\ongoin\06102026-kws"
    git fetch origin
    git switch --track origin/experiment/noise-augment-training-20261031
    $env:MSDS_KWS_SHADOW_PCM = "1"
    npm.cmd run electron:dev

Connect Camera 1. In a second PowerShell terminal verify:

    $c = (Invoke-RestMethod "http://127.0.0.1:5000/status").cameras |
      Where-Object id -eq "slot-1"
    $c.audio | Select-Object connected, thread_running, audio_source
    $c.audio.neural_shadow_pcm

Required: connected=True, thread_running=True,
neural_shadow_pcm.enabled=True.
If the tap is not enabled, a previous camera backend may still be running
on port 5000. Stop only the old MSDS camera backend and restart with the
environment variable above.

The capture tool subscribes to the same decoded camera PCM stream as DTW.
Stop the ordinary neural shadow process while recording: only one subscriber
per camera is allowed.

## 2. Record consented labeled voice WAVs

The recorder saves 16 kHz mono WAVs locally under the Git-ignored directory
local-server/neural-kws-data. All speakers must consent to recording;
never commit or upload raw recordings or identifying audio without permission.
Disable external notification delivery during controlled emergency-word
utterances.

Dataset layout:
    local-server/neural-kws-data/train/help/...
    local-server/neural-kws-data/train/fire/...
    local-server/neural-kws-data/train/emergency/...
    local-server/neural-kws-data/train/danger/...
    local-server/neural-kws-data/train/intruder/...
    local-server/neural-kws-data/train/police/...
    local-server/neural-kws-data/train/ambulance/...
    local-server/neural-kws-data/train/unknown/...
    local-server/neural-kws-data/holdout/(same eight labels)/...
    local-server/neural-kws-data/noise/*.wav
    local-server/neural-kws-data/artifacts/...

Minimum training WAVs for each of seven keywords: FIVE real recordings.
Minimum holdout WAVs per keyword: THREE independent recordings.
Minimum UNKNOWN: TEN training plus TEN holdout utterances.
Minimum environmental noise: THREE separate recordings, 5 seconds each.
For robust research, collect 20-30 varied real recordings per keyword,
across different people, rooms, recording sessions, and distances.

The recorder prompts for Enter before each take. Speak after it prints
RECORDING NOW. Take care to label each recording correctly.

Capture HELP training:

    .\local-server\capture_neural_training_wavs.cmd --label help --split train --samples 5 --seconds 1.8

Capture separate, held-out HELP recordings:

    .\local-server\capture_neural_training_wavs.cmd --label help --split holdout --samples 3 --seconds 1.8

Repeat for FIRE, EMERGENCY, DANGER, INTRUDER, POLICE, AMBULANCE.
You can iterate all seven automatically through PowerShell prompts:

    $words = @("help","fire","emergency","danger","intruder","police","ambulance")
    foreach ($word in $words) {
      .\local-server\capture_neural_training_wavs.cmd --label $word --split train --samples 5 --seconds 1.8
    }
    foreach ($word in $words) {
      .\local-server\capture_neural_training_wavs.cmd --label $word --split holdout --samples 3 --seconds 1.8
    }

Capture UNKNOWN (ordinary unrelated sentences, different speakers and
phrases, WITHOUT any emergency keyword):

    .\local-server\capture_neural_training_wavs.cmd --label unknown --split train --samples 10 --seconds 1.8
    .\local-server\capture_neural_training_wavs.cmd --label unknown --split holdout --samples 10 --seconds 1.8

Capture real fan/air-conditioner/traffic noise WITHOUT target words:

    .\local-server\capture_neural_training_wavs.cmd --label noise --samples 3 --seconds 5

Avoid using the same speakers/sessions for train and holdout when possible.
Augmented copies of a source recording must never enter holdout. One real
source should not be copied or renamed between splits.

## 3. Train an isolated candidate and evaluate

First inspect sample coverage (no training runs):

    .\local-server\train_noise_augmented_kws.cmd --check

Then train on REAL source speech with six additional noise variations
per training clip (0-22 dB random SNR, level variation, optional short echo):

    .\local-server\train_noise_augmented_kws.cmd --epochs 60 --variants 6 --seed 42

The script will stop if examples are missing, identical files appear in
train/holdout, noise is missing, or recordings are invalid/silent.

This trains a small two-layer NumPy MLP on 16x32 Log-Mel feature vectors
using an independent feature-only engine. It does not open the enrolled DTW
templates. The unknown class is required for rejected nonkeywords.

Holdout recordings are NEVER augmented or used to select training
hyperparameters. The report summarizes per-word recall, confusion and
unknown false-positive rate per clip. This is NOT false alarms/hour,
and is NOT adequate evidence for a safety deployment.

Generated files (Git-ignored, no audio uploaded):
    local-server/neural-kws-data/artifacts/noise_augmented_shadow.npz
    local-server/neural-kws-data/artifacts/noise_augmented_shadow.report.json

The model is kept in SHADOW mode even when its report is excellent.
The pretrained sherpa-onnx Zipformer remains unchanged.

## 4. Compare trained model, pretrained Zipformer, and DTW

With the same experimental camera bridge running, stop the WAV recorder.
Run this in another PowerShell terminal:

    .\local-server\start_neural_kws_shadow.cmd --seconds 180 --trained-candidate ".\local-server\neural-kws-data\artifacts\noise_augmented_shadow.npz"

Pretrained predictions print as NEURAL SHADOW.
New learned-model predictions print as NOISE TRAINED SHADOW.
DTW appears as a nearest status snapshot, not necessarily the same segment.
The trained model cannot send an alert or modify any existing KWS state.

Test quiet speech, fan/TV noise, distant speech and no-word background.
Keep manual records of the words actually spoken and their times.
A serious comparison requires false alarms/hour on long negative runs
and speaker-independent evaluation, not only classification of short WAVs.

## Technical/safety limitations

- This is NOT retraining of the pretrained Zipformer model; it is an
  independent supervised research candidate trained with real WAVs.
- Speech augmentation cannot recreate a keyword fully buried by noise.
- SNR mixing and echo are simulations, not measured room impulse responses.
- Heldout accuracy is limited by the number and diversity of real speakers.
- Candidate predictions never enter Camera Alerts or Event History.
- Local training WAVs and artifacts remain ignored by Git.
- To disable the opt-in PCM tap afterward, clear the environment variable
  and restart the local MSDS backend.

## Test script

    .\local-server\.neural-kws-venv\Scripts\python.exe -m unittest discover -s .\local-server\tests -p test_noise_augmented_kws.py -v
