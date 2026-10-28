# MSDS stable-derived voice isolation (28 October 2026)

**Base:** `stable_branch_271026` (unchanged)  
**New experimental branch:** `experiment/stable-rnnoise-voice-isolation-20261028`

## What actually changes

The original stable CCTV source flow is preserved:

`camera RTSP -> MediaMTX -> FFmpeg audio worker -> 16k PCM -> streaming VAD -> original trained log-Mel/DTW English KWS -> existing facial/visual validation`.

New optional *speech-focused* RNNoise filtering is inserted **inside the existing continuous FFmpeg audio worker, before speech segmentation**, instead of filtering after KWS has made a decision. Source audio is first converted to 48 kHz, filtered by FFmpeg `arnndn`, and downsampled to the original 16-kHz mono signed PCM. Audio is **not** sent to an external cloud service. The stable VAD/KWS boundaries, enrolled word templates, UNKNOWN rejection, keyword confidence thresholds, facial validation, event history and alert authorization are not modified. This feature processes *audio fed into KWS*; it does not automatically replace the audio heard in the video player or permanently save a cleaned WAV.

RNNoise uses a recurrent speech/noise network; unlike FFT-only filtering, it attempts to attenuate background noise while retaining speech. **It cannot isolate every human voice**, especially when multiple people are speaking, sound masks consonants, or the microphone is too far away. A voice classification filter is not a guarantee that only the intended person's voice remains.

## Presets

- `maximum`: FFmpeg `arnndn=m=sh.rnnn:mix=1`; 100% RNN-filtered audio; default for this opt-in launcher. Most suppression, potentially poorer recognition of whispers, distant voices, or short consonants.
- `balanced`: `arnndn=m=sh.rnnn:mix=0.75`; 75% RNN-enhanced plus 25% original. Often the **better first comparison** for trained words if maximum alters speech.
- `off`: exact original audio preprocessing with the old adaptive-energy VAD. No model required; the original stable KWS path remains operational.

The launcher does **not** stack a 97-dB `afftdn` FFT filter with RNNoise or run DeepFilterNet3 or sherpa-onnx in the background. WebRTC VAD mode 2 is enabled after RNNoise for `balanced` and `maximum`; confidence thresholds stay unchanged. You can compare profiles without modifying saved enrollment.

## Quick start for Windows

Close MSDS before switching branches. From PowerShell:

```powershell
cd "C:\Users\nazar\Documents\ongoin\06102026-kws"
git fetch origin
git switch --track -c experiment/stable-rnnoise-voice-isolation-20261028 origin/experiment/stable-rnnoise-voice-isolation-20261028

.\start-voice-isolation.cmd -VoiceMode maximum
```

If the branch was already created locally:

```powershell
git switch experiment/stable-rnnoise-voice-isolation-20261028
git pull --ff-only
.\start-voice-isolation.cmd -VoiceMode maximum
```

One-time setup downloads the ~291 KB community RNNoise `sh.rnnn` model
from the archived `richardpl/arnndn-models` GitHub repo at pinned revision
`0fda24c46d78f0207d820bb970fbe85c1971b39c`, checks the exact Git
blob SHA, verifies that the installed FFmpeg supports `arnndn`, and **runs
a real 0.5-second audio pass through the model** before starting Electron.
If this fails, it stops with an error instead of silently claiming voice
isolation was enabled. The model is stored at
`local-server/models/rnnoise/sh.rnnn` and does not modify any enrolled KWS
template. RNNoise adds no PyTorch/Rust dependencies.

Because PowerShell execution is restricted on some computers, the `.cmd`
wrapper uses `powershell.exe -NoProfile -ExecutionPolicy Bypass -File`
for its own subprocess only, not a system-wide setting.

## Switch immediately without retraining

```powershell
# Speech-preserving blend when maximum misses quiet syllables
.\start-voice-isolation.cmd -VoiceMode balanced

# Original unprocessed stable audio path and adaptive-energy VAD
.\start-voice-isolation.cmd -VoiceMode off

# Preflight the filter without starting Electron
.\start-voice-isolation.cmd -VoiceMode maximum -NoLaunch
```

Close MSDS fully before starting another mode.

## Critical prerequisite: the camera microphone must actually send RTSP audio

Previous CCTV diagnostics showed `connected=False`, `bytes_received=0`,
and last probed codec `aac` after the user changed the camera to PCM. No
speech enhancement can recover sound that never arrives. Reconnect Camera 1
from the app or restart the RTSP session after changing codecs; keep RTSP
audio enabled in the camera app. If PCM produces no packets, compare with
the previously working AAC_ADTS setting. The last probed codec may be stale.

Read-only status in a separate PowerShell window:

```powershell
$cam = (Invoke-RestMethod "http://127.0.0.1:5000/status").cameras |
  Where-Object id -eq "slot-1"
$cam.audio | Format-List connected,capturing,thread_running,audio_codec,bytes_received,error,ffmpeg_error
$cam.audio.custom_kws | Format-List voice_isolation_mode,voice_isolation_model_ready,voice_isolation_pipeline,vad_backend,segments_seen,last_candidate,last_decision,last_duration_ratio
```

Required before comparing noise quality: `connected=True` and
`bytes_received` increasing between polls. Actual keyword matches
may still be rejected for `duration_mismatch` if segments differ from
the original enrolled templates; don't weaken that veto without labeled
evidence.

## Validation

```powershell
& ".\local-server\.venv\Scripts\python.exe" -m unittest discover -s ".\local-server\tests" -p "test_voice_isolation.py" -v
& ".\local-server\.venv\Scripts\python.exe" -m unittest discover -s ".\local-server\tests" -p "test_kws_noise_speech_gate.py" -v
& ".\local-server\.venv\Scripts\python.exe" -m unittest discover -s ".\local-server\tests" -p "test_camera_kws.py" -v
```

If the original virtual environment does not exist, use the Python
interpreter that actually starts `local-server/camera_server.py`
and install `local-server/requirements.txt`. No AI model dependencies
beyond the FFmpeg RNNoise file are needed.

Record at least 10 consented trials each of HELP, FIRE, EMERGENCY and
other enrolled English words at 1 m and 3 m, with fan/TV/background
speech. Compare correct keyword recalls, false keyword triggers,
`duration_mismatch`, audio packet stability and latency for
`off`, `balanced` and `maximum`. For an emergency-awareness
research system, do not use stronger suppression when it damages recall.
In particular, no algorithm can reliably retain a drowned-out whisper
while also guaranteeing zero background noise.

Reference documentation:
- https://www.ffmpeg.org/ffmpeg-filters.html#arnndn
- https://github.com/richardpl/arnndn-models
