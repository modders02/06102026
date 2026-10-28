# RTSP camera video works but safety keyword microphone reports audio unavailable

Branch: `fix/rtsp-audio-detection-recovery-20261029`
Based on `experiment/far-field-voice-polish-20261029`. No change to trained KWS templates, face/fusion rules, or notification policy.

## Why this change matters

The original `probe_audio()` set `has_audio_track=False` whenever **any** RTSP candidate returned valid video-only metadata without audio, even if other candidates could not be checked. The audio worker then stopped FFmpeg capture attempts and emitted a misleading audio-unavailable warning. This could occur if the MediaMTX relay was video-only while direct CCTV RTSP connections timed out.

Now a missing-audio diagnosis is conclusive ONLY if every reachable/configured RTSP candidate is successfully probed and every one lacks audio. If one candidate fails, the state is `null` (unknown), with normal FFmpeg PCM attempts continuing. A successfully decoded >=0.5-second PCM sample overrides an inconclusive probe and marks audio available. Source-level probe outcomes are available in `audio_probe_results` without disclosing camera RTSP URLs.

The video publisher also permits a longer initial FFmpeg probe for delayed audio stream metadata (3 seconds / 1 MiB). This may slow initial video startup slightly; monitor A/V sync and camera connection stability.

## Run

```powershell
git fetch origin
git switch --track origin/fix/rtsp-audio-detection-recovery-20261029
.\start-neural-kws.cmd -SkipInstall -Mode shadow -NoiseProfile voice -HearingProfile far -FarRecheck shadow
```

From a separate PowerShell terminal, inspect the audio receiver:

```powershell
$st = Invoke-RestMethod 'http://127.0.0.1:5000/status'
$audio = ($st.cameras | Where-Object id -eq 'slot-1').audio
$audio | Select-Object has_audio_track,audio_codec,audio_source,connected,capturing,bytes_received,audio_probe_error,error
$audio.audio_probe_results | Format-Table -AutoSize
```

The camera-specific capture diagnostic endpoint also exists:

```powershell
$report = Invoke-RestMethod 'http://127.0.0.1:5000/cameras/slot-1/audio-test'
$report.probe | ConvertTo-Json -Depth 6
$report.attempts | Select-Object source,returncode,bytes,seconds,ffmpeg_error
```

Warning: diagnostic `attempts` may include camera RTSP URLs or error messages containing credentials. Do not share the full raw report publicly; share only the selected fields above after removing sensitive strings.

### Interpreting status

- `has_audio_track=True` plus increasing `bytes_received`: real PCM audio is arriving; check VAD/KWS if voice remains unrecognized.
- `has_audio_track=null` with `probe_error`: one or more sources were inaccessible, so a missing microphone is **unproven**. Check `audio_sources_tried` and `attempts`/FFmpeg errors, camera access and RTSP credentials.
- `has_audio_track=False` with all entries `ok=True` and `has_audio_track=False`: every RTSP candidate reported video-only. In camera admin/app, enable **microphone/audio stream/RTSP audio** (AAC or G.711 as supported) and select the correct main/substream, then reconnect the camera to renegotiate tracks. Software cannot generate real microphone audio if the stream lacks it.
- Camera offers a separate audio-enabled RTSP substream: configure the connected camera with that verified URL, then reconnect. Video or audio source switching must be explicit; the application does not guess vendor URLs.

## Regression tests

```powershell
& '.\local-server\.venv\Scripts\python.exe' -m unittest discover -s '.\local-server\tests' -p 'test_camera_audio_probe_recovery.py' -v
& '.\local-server\.venv\Scripts\python.exe' -m unittest discover -s '.\local-server\tests' -p 'test_rtsp_audio_timestamp.py' -v
& '.\local-server\.venv\Scripts\python.exe' -m unittest discover -s '.\local-server\tests' -p 'test_camera_lifecycle.py' -v
```

These tests use mocked RTSP tools; real CCTV capture and hardware sound cannot be verified from GitHub. Test with external emergency alerts disabled until verified.
