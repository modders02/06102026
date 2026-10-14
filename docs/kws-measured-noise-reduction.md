# KWS: measured 80% stationary-noise-power goal (experimental)

**No setting guarantees 80% noise suppression on every room or camera.**
This experiment provides a stronger filter and a fail-closed benchmark. It
distinguishes **noise power attenuation** from **wake-word recognition accuracy**.
A measured 80% reduction in noise power equals about 7 dB; removing 80% of
background conversation is not implied. The reference noise clip must contain
**no speech**.

## What changed

- Set `MSDS_KWS_AUDIO_DENOISE=1` to enable the CCTV-only FFT denoising path.
- Set `MSDS_KWS_NOISE_PROFILE=strong` for the candidate stronger profile:
  high-pass 120 Hz, low-pass 4.2 kHz, adaptive FFmpeg `afftdn`
  (`nr=24:nf=-30:tn=1`), resample to 16 kHz and regenerate PCM timestamps.
  Default profile `standard` remains identical to the previous branch.
- Keep `MSDS_KWS_WEBRTC_VAD=1` for optional speech detection.
- Use `local-server/benchmark_kws_noise.py` to evaluate the *exact same*
  FFmpeg filtering offline on a noise-only WAV and an independent labeled
  wake-word corpus.
- No templates are modified or uploaded. No emergency-dispatch condition,
  90% HELP fast acceptance, UNKNOWN veto or duration limits are weakened.

## Prepare and launch on Windows

Close existing MSDS/Python servers. In PowerShell:

```powershell
cd "C:\Users\nazar\Documents\ongoin\06102026-kws"
& ".\local-server\.venv\Scripts\python.exe" -m pip install -r ".\local-server\requirements.txt"

$env:MSDS_KWS_VERIFY_ASR = "0"
$env:MSDS_KWS_HELP_RESCUE = "0"
$env:MSDS_KWS_HELP_90_FAST_ACCEPT = "1"
$env:MSDS_KWS_WEBRTC_VAD = "1"
$env:MSDS_KWS_WEBRTC_MODE = "2"
$env:MSDS_KWS_AUDIO_DENOISE = "1"
$env:MSDS_KWS_NOISE_PROFILE = "strong"
npm.cmd run electron:dev
```

In a second terminal:

```powershell
$st = Invoke-RestMethod "http://127.0.0.1:5000/status"
$cam = $st.cameras | Where-Object id -eq "slot-1"
$cam.audio.custom_kws | Select-Object vad_backend,audio_denoise_enabled,audio_noise_profile,segments_seen,last_candidate,last_candidate_confidence,last_decision
```

Expect `audio_denoise_enabled=True`, `audio_noise_profile=strong`,
`vad_backend=webrtc-2`. If the backend was already using port 5000
before restart, Electron might reuse that old process and these settings
will not take effect.

## Record a noise-only reference (10 seconds)

Do this with participants informed and consenting, with no one speaking.
Turn off outgoing alerts during the trial. Keep the MSDS camera connected.
From another terminal in the project root:

```powershell
$cam = (Invoke-RestMethod "http://127.0.0.1:5000/status").cameras |
    Where-Object id -eq "slot-1"
$source = "rtsp://127.0.0.1:8554/$($cam.path)"
& ".\local-server\bin\ffmpeg.exe" -nostdin -hide_banner -loglevel error `
    -rtsp_transport tcp -i $source -map 0:a:0 -vn -t 10 `
    -ac 1 -ar 16000 -c:a pcm_s16le ".\noise-only-slot1.wav"
```

Do not commit noise-only or speech WAVs to Git; retain consented
recordings locally.

## Collect independent, labeled speech tests

Use previously unseen real CCTV microphone recordings that were **not
used for enrollment**. Trim each audio WAV to one utterance lasting
0.30–2.50 seconds, export uncompressed mono PCM16 at 16 kHz, and sort
into folders:

```text
local-server/kws-holdout-english/
  help/        (>=3 independent clips)
  fire/        (>=3)
  emergency/   (>=3)
  danger/      (>=3)
  intruder/    (>=3)
  police/      (>=3)
  ambulance/   (>=3)
  unknown/     (>=10 ordinary/confusable speech clips)
```

For more credible noisy-room claims, collect **at least 10 samples per
word across several speakers and distances** and substantial
noise-only/no-keyword monitoring time. These minimum counts are not
sufficient for general deployment confidence.

Run while the live app is not essential:

```powershell
& ".\local-server\.venv\Scripts\python.exe" `
    ".\local-server\benchmark_kws_noise.py" `
    --noise-only ".\noise-only-slot1.wav" `
    --holdout ".\local-server\kws-holdout-english" `
    --profile strong
```

Exit code 0 means **only** that the provided dataset met the
noise-power and held-out recognition targets. Exit code 1 means
not qualified; exit code 2 means configuration/input failure.
The JSON report includes raw/filtered results per keyword. The
benchmark does not score the continuous streaming VAD: test onset,
offset, missed keywords and false alarms per hour separately with
your actual camera.

Without `--holdout`, the script can measure the noise-only filter
but must report `qualified=false`. It is not evidence of word
recognition accuracy.

## Interpretation and safety

- Target: **>=80% attenuation of noise-only mean-square audio power**.
- Separate target: **>=90% held-out positive recall** and
  **<=5% false accepts on UNKNOWN clips**. These targets must be
  measured in representative noisy-room conditions.
- Strong denoising may **harm** word discrimination by altering speech
  spectra relative to old `.npy` templates. If noisy recall worsens,
  compare with `MSDS_KWS_NOISE_PROFILE=standard` or
  `MSDS_KWS_AUDIO_DENOISE=0`, and record new training WAVs under the
  intended audio processing settings for controlled retraining.
- Turn off automatic external alerts during experimental testing.
  Facial/visual corroboration must remain mandatory before any
  emergency dispatch.

This code alone does not claim 80% noise removal in your room, nor
80–90% noisy-room keyword accuracy. Both require the recordings above.
