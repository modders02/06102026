# Noisy-room voice recognition trial (not production validated)

This branch adds two **opt-in** experiments, without altering your KWS enrollment
templates, 90% HELP shortcut, UNKNOWN class margin, duration gate, or visual
corroboration before safety alerts:

1. `MSDS_KWS_WEBRTC_VAD=1`: WebRTC VAD on 16-kHz, 20-ms PCM audio
   frames with an ambient-energy guard. Installs as the small
   `webrtcvad-wheels` Python dependency. Default mode: 2; modes 0–3
   are configurable through `MSDS_KWS_WEBRTC_MODE` (higher is
   more aggressive, potentially missing distant speech).
2. `MSDS_KWS_AUDIO_DENOISE=1`: FFmpeg high-pass, low-pass and
   `afftdn` noise reduction on **only** the separate keyword/audio
   capture stream. It does not modify the camera's video publication.
   Stationary noise like a fan may be reduced; loud music, television,
   competing speakers, and low-SNR distant speech remain challenging.

Both features are OFF by default so existing installations and tests
are unaffected. They must be compared against the same genuine camera audio.
If WebRTC is requested but unavailable, `vad_backend` explicitly reports
an unavailable package and falls back to the old adaptive-energy VAD.

## Windows trial in the current project

Close existing Electron/standalone Python camera servers first, then run
from PowerShell (not inside `local-server`):

```powershell
cd "C:\Users\nazar\Documents\ongoin\06102026-kws"
& ".\local-server\.venv\Scripts\python.exe" -m pip install -r ".\local-server\requirements.txt"

$env:MSDS_KWS_VERIFY_ASR = "0"
$env:MSDS_KWS_HELP_RESCUE = "0"
$env:MSDS_KWS_HELP_90_FAST_ACCEPT = "1"
$env:MSDS_KWS_WEBRTC_VAD = "1"
$env:MSDS_KWS_WEBRTC_MODE = "2"
$env:MSDS_KWS_AUDIO_DENOISE = "1"

npm.cmd run electron:dev
```

Then, in a second terminal:

```powershell
$st = Invoke-RestMethod "http://127.0.0.1:5000/status"
$cam = $st.cameras | Where-Object id -eq "slot-1"
$cam.audio | Select-Object connected,chunks_received,audio_source,ffmpeg_error
$cam.audio.custom_kws | Select-Object vad_backend,audio_denoise_enabled,segments_seen,vad_noise_floor_rms,vad_last_speech_frame,vad_max_length_drops,last_segment_ms,last_candidate,last_candidate_confidence,last_duration_ratio,last_decision,last_keyword
```

You should see `vad_backend: webrtc-2` and
`audio_denoise_enabled: True`. If you see `adaptive-energy
(WebRTC package unavailable)`, check whether pip ran in the exact
`.venv` used by the MSDS camera server.

## Controlled evaluation

Disable outbound notifications while testing. Test quiet and noisy cases
separately. Record at least 10 consented, **previously unseen** spoken
utterances of each of seven English emergency keywords (if practicable, multiple
speakers, distances) and substantial ordinary, background and confusable
non-keyword speech. Compare opt-in ON with both opt-in variables set to 0,
using the same audio conditions or replayed recordings.

Report per-word recall and false accepts per hour of real ambient audio.
A prior 97.5% leave-one-template-out audit does **not** estimate noisy-room
recognition accuracy. A stale `last_keyword` is historical; look at
`last_segment_at` and `last_decision` to judge the newest utterance.

If noise reduction degrades trained-template similarity, set
`MSDS_KWS_AUDIO_DENOISE=0` and restart without changing templates.
If WebRTC filters out distant genuine speech, compare modes 1 and 2
without disabling the UNKNOWN/duration gates. Never lower the 90%
HELP threshold just to mask a recognition problem.

Neither WebRTC VAD nor denoising can recover inaudible speech.
A low quality CCTV microphone, high competing speech/noise, source
timestamp errors or a mismatch between training and live audio
require better recording quality, controlled re-enrollment and
independent validation.
