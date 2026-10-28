# Experimental noisy-room KWS trial — 28 October 2026

**Source branch:** `stable_branch_271026`  
**Experimental branch:** `experiment/noise-robust-kws-20261028`

This experiment reuses the already implemented **FFmpeg spectral denoising**
and **WebRTC speech VAD** with one configuration switch, and adds a
reproducible offline signal-to-noise ratio (SNR) comparison. The engine
remains the trained 16-kHz, Log-Mel + DTW English KWS (help, fire,
emergency, danger, intruder, police, ambulance, plus unknown).

**What this is not:** proof of 90%+ accuracy in all noisy rooms, a production
safety certification, a switch to Whisper for primary recognition, or an
automatic retraining of your enrollment. The output measures pre-segmented
clips; the live VAD and end-to-end alert path must be evaluated separately.

## 1. Keep the stable branch untouched

In Windows PowerShell, from your project folder:

```powershell
git fetch origin
git switch --track origin/experiment/noise-robust-kws-20261028
```

If the branch already exists locally, use `git switch experiment/noise-robust-kws-20261028`.
Stop Electron and any separate Python camera server before starting the trial,
so the server process inherits the new environment variables.

## 2. Select a trial mode

The new `MSDS_KWS_ROBUST_MODE` setting chooses a preset:

| Mode | FFmpeg live audio | WebRTC VAD | Intended use |
|---|---|---|---|
| `off` (default) | Existing behavior | Existing behavior | Unchanged stable baseline |
| `standard` | high-pass 120 Hz; low-pass 4200 Hz; `afftdn=nr=12:nf=-40:tn=1` | Requested, mode 2 | Initial mild/moderate room noise trial |
| `strong` | same band-pass; `afftdn=nr=24:nf=-30:tn=1` | Requested, mode 2 | Stationary-noise experiment; may damage short words |

The older `MSDS_KWS_AUDIO_DENOISE`, `MSDS_KWS_NOISE_PROFILE`, and
`MSDS_KWS_WEBRTC_VAD` environment variables continue to work independently
when robust mode is off. To establish a true baseline, explicitly set all
legacy switches to `0`.

**Baseline, before comparing:**

```powershell
$env:MSDS_KWS_ROBUST_MODE = "off"
$env:MSDS_KWS_AUDIO_DENOISE = "0"
$env:MSDS_KWS_WEBRTC_VAD = "0"
$env:MSDS_KWS_HELP_90_FAST_ACCEPT = "0"
$env:MSDS_KWS_VERIFY_ASR = "0"
npm.cmd run electron:dev
```

**Experimental standard mode, in a fresh server process:**

```powershell
& ".\local-server\.venv\Scripts\python.exe" -m pip install -r ".\local-server\requirements.txt"
$env:MSDS_KWS_ROBUST_MODE = "standard"
$env:MSDS_KWS_AUDIO_DENOISE = "0"
$env:MSDS_KWS_WEBRTC_VAD = "0"
$env:MSDS_KWS_WEBRTC_MODE = "2"
$env:MSDS_KWS_HELP_90_FAST_ACCEPT = "0"
$env:MSDS_KWS_VERIFY_ASR = "0"
npm.cmd run electron:dev
```

Do **not** compare modes with different KWS shortcuts or ASR verification
settings; the recognizer must be evaluated fairly. If you deliberately
use the 90% HELP shortcut or ASR verification in production, test that
separately with those exact settings.

**Confirm the live runtime:**

```powershell
$st = Invoke-RestMethod "http://127.0.0.1:5000/status"
$cam = $st.cameras | Where-Object id -eq "slot-1"
$cam.audio.custom_kws | Select-Object audio_robust_mode,audio_denoise_enabled,audio_noise_profile,vad_webrtc_requested,vad_backend,vad_noise_floor_rms,last_candidate,last_decision
```

For a working standard trial you should see
`audio_robust_mode=standard`, `audio_denoise_enabled=True`, and
`vad_backend=webrtc-2`. If VAD reports `adaptive-energy (WebRTC package
unavailable)`, fix the Python installation before drawing conclusions.
The preset filters the **audio pipe only**, not the video publisher.

## 3. Prepare independent comparison recordings

Create the following folders (the WAVs must **never** have been enrolled).
Each file should be PCM16 mono, exactly 16,000 Hz, 0.3–2.5 seconds.

```text
local-server/kws-holdout-english/
    help/          (at least 3 new utterances)
    fire/
    emergency/
    danger/
    intruder/
    police/
    ambulance/
    unknown/       (at least 10 non-keywords, including confusable words)
```

Record a separate `room-noise.wav` of at least 2 seconds containing
**no personal conversations**, ideally 10–30 seconds of the actual fan,
television ambience, or indoor background noise. Do not include any
private speech, CCTV access details, or identifying information in a
shared dataset. Keep the raw recordings local.

For a stronger study, collect at least 10 unseen examples per keyword,
multiple distances and speakers, and 30+ negatives (e.g., "hello",
"ambulances", "polish", TV speech) if consented. Avoid overlapping any
enrollment recordings or the UNKNOWN templates.

## 4. Compare 20 / 15 / 10 / 5 / 0 dB SNR with frozen templates

```powershell
& ".\local-server\.venv\Scripts\python.exe" ".\local-server\compare_kws_snr.py" `
  --holdout ".\local-server\kws-holdout-english" `
  --noise-only ".\room-noise.wav" `
  --snrs 20 15 10 5 0 `
  --profiles off standard strong `
  --max-files-per-class 10
```

The script adds recorded room noise at the requested SNR and includes a
1-second noise-only warmup for the denoiser, then evaluates the same
speech interval with the original frozen KWS templates.

For every noise level and profile, inspect:

- `keyword_recall`: proportion of true keywords correctly accepted.
- `unknown_false_accept_rate`: proportion of non-keyword clips accepted
  as **any** emergency keyword.
- `by_keyword`: per-word correct counts, especially `help` and `fire`.
- `adequate_sample_counts`: whether the dataset meets minimum sample counts.

An FFmpeg noise-power reduction percentage is **not** KWS recall.
Changes in the class margins and UNKNOWN rejection gate must be judged by
both missed real keywords and false accepted words. The script does not
silently bypass either gate.

A passing software test, a synthetic SNR improvement, or low stationary
noise power **does not establish field accuracy**. Repeat the same
comparison with real noisy CCTV recordings and assess VAD segmentation,
keyword detection time, false alarm rate per hour, and downstream visual
validation before deployment.

## 5. Test suite and rollback

```powershell
& ".\local-server\.venv\Scripts\python.exe" -m unittest discover -s ".\local-server\tests" -p "test_kws_*.py"
npm.cmd test -- --run
npm.cmd run build
```

To turn the experiment off in the current shell, stop Electron and restart
with:

```powershell
$env:MSDS_KWS_ROBUST_MODE = "off"
$env:MSDS_KWS_AUDIO_DENOISE = "0"
$env:MSDS_KWS_WEBRTC_VAD = "0"
npm.cmd run electron:dev
```

To return entirely to the previously stable source:

```powershell
git switch stable_branch_271026
```

**Do not modify / clear / re-enroll the live model templates during this
A/B test.** Training and hard-negative augmentation should follow a
separate, controlled, backed-up trial only after we see the measured
confusion matrix and actual room-noise failure cases.
