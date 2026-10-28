# MSDS: Audio/KWS reliability recovery and diagnostic procedure

Experimental recovery branch: `fix/kws-speech-preservation-diagnostics-20261028`  
Original experiment: `experiment/deepfilternet-sherpa-kws-20261028` (unchanged)  
Stable baseline: `stable_branch_271026` (unchanged)

## Why the earlier "Maximum / Strong / Far" choices can all fail

1. The `maximum` FFmpeg `afftdn=nr=97` attenuation is the **highest filter setting**, not the most accurate speech enhancement. In some conditions it removes consonants and weak/distant voices **before** the classifier has any chance to recognize them.
2. `Far` originally increased pre-roll from 120 to 200 ms, shortened the minimum segment from 300 to 260 ms and changed end-silence. The manually enrolled DTW templates and duration ratios were calibrated with the old segmentation. Additional leading noise and changed durations can reduce recognition.
3. WebRTC VAD is a **speech onset filter**, not a keyword recognizer. A more permissive VAD can admit noise and cause more false segments; a strict mode can miss quiet words.
4. The neural DeepFilterNet + sherpa-onnx integration runs in **shadow** mode by default in the old branch. It records diagnostic agreement/disagreement, **but does not trigger** or rescue actual DTW keywords. On low-end CPUs it also competes for processing time.
5. `NoiseProfile off` on the prior launcher **still enabled WebRTC VAD**. Therefore that setting did not reproduce the raw adaptive-energy DTW baseline.

This recovery branch preserves existing trained KWS templates, thresholds,
UNKNOWN rejection, face-validation rules and existing event-history fixes.
It deliberately does not promote neural shadow guesses into emergency alerts.

## Corrections

- **Default launch:** `-Mode off -NoiseProfile standard -HearingProfile normal`.
  - The 12-dB FFmpeg noise-reduction filter targets modest background noise.
  - WebRTC mode 2 is the default speech detector.
  - Audible MediaMTX/WebRTC publisher is **not** additionally denoised.
  - No neural downloads, model checks or background inference unless
    explicitly using `-Mode shadow` or `-Mode verify`.
- **Far hearing:** May use the lower VAD energy gate and two-frame speech
  start, but retains the original `120 ms` pre-roll, `300 ms` minimum
  and `240 ms` end-silence. This minimizes deviations from enrollment.
- **Raw baseline:** `-Mode off -NoiseProfile off -HearingProfile adaptive`
  disables FFmpeg denoising, WebRTC VAD and neural inference. The
  existing custom Log-Mel + DTW engine and its enrollment are retained.
- **Read-only diagnosis:** `local-server/diagnose-live-kws.ps1` inspects
  audio byte counters, active source, live RMS/floor, VAD backend,
  segments, last keyword candidate, accepted/rejected decision and
  neural mode. It does not record or export audio.

## Run the recommended recovery on Windows

Close Electron and existing local-server terminal. From the project
root (do not reset or delete your templates):

```powershell
git fetch origin
git switch --track origin/fix/kws-speech-preservation-diagnostics-20261028

.\start-neural-kws.cmd -SkipInstall -Mode off -NoiseProfile standard -HearingProfile normal
```

If the branch is already available locally, simply run
`git switch fix/kws-speech-preservation-diagnostics-20261028`, then
`git pull --ff-only`.

**Do not** use `-Mode verify` as a debugging shortcut: its strict
two-engine agreement gate can reject more genuine words.

## Inspect the actual microphone while speaking

In a separate PowerShell window (while MSDS is running):

```powershell
.\local-server\diagnose-live-kws.ps1 -CameraId slot-1 -Seconds 40 -EverySeconds 2
```

Speak each enrolled emergency keyword clearly at ~1 m and then ~3 m.
A single `RMS` value is not proof the keyword was segmented; read
`bytes_received`, `segments_seen`, `last_candidate` and
`last_decision` together.

Interpretation:
- **Audio disconnected / 0 new bytes**: Fix the CCTV mic/audio track,
  RTSP codec, relay or capture process first. No VAD or classifier
  setting can recover missing data.
- **New bytes, 0 speech segments**: Diagnose WebRTC/energy VAD and
  denoising. Compare raw adaptive baseline below.
- **Segments, no accepted words**: The classifier/UNKNOWN veto/duration
  gates or mismatched enrollment templates are likely the blocker.
  Review `last_candidate`, `last_decision`, `last_duration_ratio`,
  `last_class_margin` and `last_negative_confidence`.
- **Accepted word but no emergency alert**: Check the **separate**
  five-second facial/visual validation process. Do not change KWS
  confidence to force a camera alert.
- **Neural mode shows shadow**: Neural processing does not authorize
  or rescue alerts. Compare only after the DTW path is working.

## Confirm original raw DTW baseline

Stop MSDS and start the same branch with no FFmpeg FFT/WeRTC/neural
processing:

```powershell
.\start-neural-kws.cmd -SkipInstall -Mode off -NoiseProfile off -HearingProfile adaptive
```

This gives a meaningful reference for whether the new filters are
responsible for words being lost.

If raw works but standard does not, compare:

```powershell
.\start-neural-kws.cmd -SkipInstall -Mode off -NoiseProfile off -HearingProfile far
```

This uses the original raw audio with more sensitive WebRTC VAD.
If it misses words too, inspect the recorded camera signal,
the mic's position, background reverberation and actual enrolled samples.

Only **after** confirming a working DTW baseline should you compare
neural shadow mode:

```powershell
.\start-neural-kws.cmd -SkipInstall -Mode shadow -NoiseProfile standard -HearingProfile normal
```

## Regression tests

```powershell
& ".\local-server\.venv\Scripts\python.exe" -m unittest discover -s ".\local-server\tests" -p "test_kws_far_hearing.py" -v
& ".\local-server\.venv\Scripts\python.exe" -m unittest discover -s ".\local-server\tests" -p "test_kws_robust_experiment.py" -v
& ".\local-server\.venv\Scripts\python.exe" -m unittest discover -s ".\local-server\tests" -p "test_neural_kws_trial.py" -v
npm.cmd run build
```

These tests must actually run on Windows to verify compatibility; the
source-level code review alone does not establish that the CCTV can
hear quieter words or that the system meets real-world safety targets.

## If every configuration still fails

Share the **non-sensitive output** of the live diagnostic and the name
of the keyword spoken. Do not share RTSP passwords or URLs. Measure
per-word hits and false triggers over consenting trials at varied
distances; do not claim improvement from the mere fact that a filter
has a numerically higher setting.

Use the last-known-working source for demonstrations if the recovery
branch does not pass your checks. Existing original experiment branch
and stable branch remain available.
