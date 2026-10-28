# Far Hearing KWS: quieter and more distant CCTV speech (28 October 2026)

> **Recovery branch note (28 October 2026):** The previous aggressive default presets may lose quiet words. On `fix/kws-speech-preservation-diagnostics-20261028`, this launcher now starts with **DTW-only, standard noise filtering and normal hearing**, not neural shadow / maximum / far. See `docs/kws-audio-reliability-recovery-20261028.md` for the recommended first test and raw baseline.


**Experimental branch:** `experiment/deepfilternet-sherpa-kws-20261028`  
**Stable branch:** `stable_branch_271026` (unchanged)

## Why this change exists

The preceding **Maximum** noise-suppression preset works for the user,
but can miss quieter or more distant emergency words. Its WebRTC VAD mode
3, three-frame speech onset, and additional energy floor are optimized for
rejecting background sound, rather than hearing quiet speech. Extremely
aggressive `afftdn nr=97` filtering can also remove real speech.

## Added Far Hearing mode

The neural trial launcher now defaults to `-HearingProfile far`.
This affects **audio segmentation only**, not trained classifier matches:

| Control | Normal hearing | Far hearing |
|---|---|---|
| WebRTC VAD (Maximum FFT preset) | 3 (most restrictive) | 1 (more sensitive) |
| Speech-onset confirmation | 3 × 20 ms = 60 ms | 2 × 20 ms = 40 ms |
| Pre-roll kept | 120 ms | 200 ms |
| Minimum extracted speech segment | 300 ms | 260 ms |
| Silence needed to finish a segment | 240 ms | 280 ms |
| WebRTC energy gate | max(0.007, noise floor × 1.08) | max(0.0035, noise floor × 1.03) |
| Fallback adaptive-energy start threshold | Original RMS gate | Softer noise-relative RMS gate |
| DTW, keyword thresholds, UNKNOWN veto, margins | Unchanged | Unchanged |
| Speech–face emergency verification | Unchanged | Unchanged |

DeepFilterNet3 + sherpa-onnx continues in **shadow** mode by default and
cannot independently publish emergency alerts. VAD level 1 may admit
more non-speech, so false-positive and false-negative rates must be measured.

## Start on Windows

Stop the running Electron application/server and open PowerShell:

```powershell
cd "C:\Users\nazar\Documents\ongoin\06102026-kws"
git pull --ff-only origin experiment/deepfilternet-sherpa-kws-20261028
.\start-neural-kws.cmd -SkipInstall -NoiseProfile maximum -HearingProfile far
```

This retains the existing Maximum FFT playback noise suppression and
full DeepFilterNet neural processing, but makes the **VAD more willing
to listen for quiet words**. It does not increase microphone hardware
sensitivity or guarantee detection at a particular distance.

If you notice quiet words still disappearing, the **maximum** FFT filter
itself may already have removed them; try **Strong** noise suppression
with the same Far Hearing setting:

```powershell
.\start-neural-kws.cmd -SkipInstall -NoiseProfile strong -HearingProfile far
```

For the original previous Maximum behavior, without the more sensitive
listening mode:

```powershell
.\start-neural-kws.cmd -SkipInstall -NoiseProfile maximum -HearingProfile normal
```

These switches affect only the running experimental process and do not
retrain or overwrite enrollment data. Switching profiles requires stopping
and restarting Electron.

## Check the *actual* running camera

```powershell
$st = Invoke-RestMethod "http://127.0.0.1:5000/status"
$cam = $st.cameras | Where-Object id -eq "slot-1"
$cam.audio.custom_kws | Select-Object hearing_profile,vad_backend,
    vad_start_confirm_frames,vad_min_speech_seconds,
    vad_preroll_seconds,vad_speech_energy_gate,
    audio_noise_profile,last_candidate,last_decision,neural_candidate,
    neural_last_error
```

With Far Hearing and a working WebRTC installation, `hearing_profile`
should read `far` and `vad_backend` should read `webrtc-1`.
If `adaptive-energy (WebRTC package unavailable)` appears, check that
the same Python virtual environment contains `webrtcvad-wheels`.

## Test

```powershell
& ".\local-server\.venv\Scripts\python.exe" -m unittest discover -s ".\local-server\tests" -p "test_kws_far_hearing.py" -v
& ".\local-server\.venv\Scripts\python.exe" -m unittest discover -s ".\local-server\tests" -p "test_kws_noisy_vad.py" -v
& ".\local-server\.venv\Scripts\python.exe" -m unittest discover -s ".\local-server\tests" -p "test_kws_noise_speech_gate.py" -v
```

The new regression tests use synthetic low-volume audio and mocked WebRTC
VAD for deterministic threshold comparisons. They do **not** certify
real CCTV keyword recall or noise performance.

For a realistic trial, stand at 1, 2, 3, and 5 meters from the **CCTV
microphone** in a controlled setting, speak each of the seven configured
English emergency keywords at normal and quiet speaking volume, and
compare Maximum+Far / Strong+Far / Maximum+Normal. Record the number of
correct triggers, missed genuine words, false triggers from TV/fan noise,
and latency. Use supervised test mode and disable emergency notification
delivery until the selected settings are validated.

For greater real-world range, positioning, microphone quality and
acoustic reverberation are important; software sensitivity is not
equivalent to acoustic noise removal.
