# MSDS Maximum Noise Cancellation experiment (28 October 2026)

> **Recovery branch note (28 October 2026):** The previous aggressive default presets may lose quiet words. On `fix/kws-speech-preservation-diagnostics-20261028`, this launcher now starts with **DTW-only, standard noise filtering and normal hearing**, not neural shadow / maximum / far. See `docs/kws-audio-reliability-recovery-20261028.md` for the recommended first test and raw baseline.


**Experimental branch:** `experiment/deepfilternet-sherpa-kws-20261028`  
**Stable branch:** `stable_branch_271026` (not changed)

The launcher now includes a separate **Far Hearing** mode for quiet/distant
words (default), documented in
`docs/far-hearing-kws-20261028.md`. This is separate from FFT filtering.

This is a **maximum-suppression experimental mode**, not a guarantee of improved
word-recognition accuracy. Very aggressive denoising may erase `help`, `fire`,
and other short emergency words. Compare measured recall and false positives
before any real-world use. Keep alerts/notifications in supervised test mode.

## What "Maximum" actually means

For this experimental launcher's CCTV audio:

1. **Audible CCTV / MediaMTX/WebRTC stream:** The experimental Maximum
   launcher enables FFmpeg high-pass 120 Hz, low-pass 4.2 kHz, and
   `afftdn=nr=97:nf=-30:tn=1` on 48-kHz Opus playback audio.
2. **Live 16-kHz DTW input:** When KWS reads that already denoised MediaMTX
   stream, its PCM decoder **skips the second FFT filter** to avoid
   destructive double processing. When it uses the original camera
   directly as fallback, its PCM decoder runs the maximum FFT filter once.
   `nr=97` is FFmpeg's **maximum configurable value**, not a measured
   guarantee of 97 dB real-world noise reduction. Enrollment templates
   remain unchanged.
3. **Voice activity detection:** The newer Far Hearing preset (default
   for this experimental launcher) uses WebRTC VAD mode **1** for better
   detection of quiet/distant speech. Use `-HearingProfile normal` to restore
   the original mode **3** Maximum configuration. The VAD is a speech
   classifier, not a noise remover.
4. **Neural comparison (shadow mode):** DeepFilterNet3 processes each
   accepted VAD segment at 48 kHz using `atten_lim_db=None` (unlimited
   model suppression). Output is resampled to 16 kHz for sherpa-onnx.
   Shadow mode cannot directly generate an emergency alert.
5. **Runtime diagnostics:** `audio_robust_mode`, `audio_noise_profile`,
   `publisher_audio_denoise_enabled`, `publisher_noise_profile`,
   `vad_backend`, `neural_mode`, `neural_enhancement_strength`,
   `neural_attenuation_limit_db`, `neural_candidate`,
   `neural_processing_ms`, and `neural_last_error`.

**Audio/video sync risk:** FFT denoising on the RTSP publisher takes
processing time and may delay the audible feed relative to video. Test
speech and lip movements together. If the audible stream lags, close
MSDS and start with `-NoiseProfile strong`, which disables publisher
filtering while keeping 24-dB FFT reduction on the KWS PCM path.

**Architecture limitation:** DeepFilterNet3 runs **after** speech segmentation,
not on the continuous pre-VAD stream. Maximum FFT suppression therefore
affects the DTW/VAD live input, while DeepFilterNet3 only enhances segments
that VAD already detected. On CPU, neural processing may be slow.

## Start in maximum mode (now the default for this experimental installer)

Close Electron and the local Python camera server, then in Windows PowerShell:

```powershell
cd "C:\Users\nazar\Documents\ongoin\06102026-kws"
git pull --ff-only origin experiment/deepfilternet-sherpa-kws-20261028
.\start-neural-kws.cmd -SkipInstall
```

For an explicit mode selection:

```powershell
.\start-neural-kws.cmd -SkipInstall -NoiseProfile maximum
```

The `-SkipInstall` switch requires the neural Python environment and
downloaded models to be installed and healthy. Otherwise omit it.
The old VAD/DTW safety validation thresholds and the existing facial
five-second verification are unchanged.

## Quick rollback without changing Git branches

If quiet speech is missed or the microphone sounds distorted, close
Electron and relaunch with the selected profile:

```powershell
# Less aggressive pre-VAD denoising (24 dB FFT reduction, WebRTC VAD 2)
.\start-neural-kws.cmd -SkipInstall -NoiseProfile strong

# Mild pre-VAD denoising (12 dB FFT reduction, WebRTC VAD 2)
.\start-neural-kws.cmd -SkipInstall -NoiseProfile standard

# Original unfiltered DTW PCM, with WebRTC VAD 2
.\start-neural-kws.cmd -SkipInstall -NoiseProfile off
```

Because the launcher explicitly enables WebRTC VAD for its comparison,
`-NoiseProfile off` is **not an identical reproduction of the stable
branch's original VAD default**. For complete baseline behavior, switch
back to `stable_branch_271026` and use the stable launch command.

## Verify actual configuration

```powershell
$st = Invoke-RestMethod "http://127.0.0.1:5000/status"
$cam = $st.cameras | Where-Object id -eq "slot-1"
$cam.audio.custom_kws |
    Select-Object audio_robust_mode,audio_denoise_enabled,audio_noise_profile,
        publisher_audio_denoise_enabled,publisher_noise_profile,
        vad_backend,neural_mode,neural_enhancement_strength,
        neural_attenuation_limit_db,neural_candidate,
        neural_processing_ms,neural_last_error
```

Expected **configured** Maximum + Far Hearing:
`audio_robust_mode=maximum`,
`audio_denoise_enabled=True`, `publisher_audio_denoise_enabled=True`,
`publisher_noise_profile=maximum`, `hearing_profile=far`,
`vad_backend=webrtc-1` (or `webrtc-3` if using `-HearingProfile normal`),
`neural_enhancement_strength=maximum` and a **null**
`neural_attenuation_limit_db` (meaning no model attenuation cap).
These configuration flags do not certify actual acoustic performance.

## Tests

```powershell
& ".\local-server\.venv\Scripts\python.exe" -m unittest discover -s ".\local-server\tests" -p "test_kws_robust_experiment.py" -v
& ".\local-server\.venv\Scripts\python.exe" -m unittest discover -s ".\local-server\tests" -p "test_neural_kws_trial.py" -v
& ".\local-server\.venv\Scripts\python.exe" -m unittest discover -s ".\local-server\tests" -p "test_rtsp_audio_timestamp.py" -v

# Holdout files must be NEW WAVs, not enrollment examples.
& ".\local-server\.venv\Scripts\python.exe" ".\local-server\compare_kws_snr.py" `
  --holdout ".\local-server\kws-holdout-english" `
  --noise-only ".\room-noise.wav" `
  --snrs 20 15 10 5 0 --profiles off standard strong maximum
```

At each SNR, compare `keyword_recall`,
`unknown_false_accept_rate`, per-word `predictions`, and
speech-detection latency. In particular check short `help` and `fire`
and quiet/whispered calls. If maximum suppression lowers recall,
**use the most effective measured profile, not the numerically strongest**.

Official references:
- https://ffmpeg.org/ffmpeg-filters.html#afftdn
- https://github.com/Rikorose/DeepFilterNet/blob/main/DeepFilterNet/df/enhance.py
