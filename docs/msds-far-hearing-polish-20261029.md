# MSDS usability and reliability polish — Far Hearing / Maximum / Shadow

**Base:** `experiment/deepfilternet-sherpa-kws-20261028`  
**Polishing branch:** `polish/msds-far-hearing-ui-diagnostics-20261029`

This stage improves the user-facing accuracy of audio status and keyword
diagnostics. It does **not** lower the model's confidence gate, remove UNKNOWN
rejection, change emergency alert approval, overwrite voice enrollment samples,
or change facial-expression requirements.

## Keep your exact existing startup configuration

Close the running Electron application and launch from the project root:

```powershell
git fetch origin
git switch --track origin/polish/msds-far-hearing-ui-diagnostics-20261029
.\start-neural-kws.cmd -SkipInstall -Mode shadow -NoiseProfile maximum -HearingProfile far
```

For an existing local branch, use `git switch
polish/msds-far-hearing-ui-diagnostics-20261029` and `git pull --ff-only`
before launching. Do not switch branches with uncommitted work that Git says
would be overwritten.

**Exact mode behavior:**
- **Far Hearing:** more permissive WebRTC VAD for low-level speech, with
  original KWS duration/margin/UNKNOWN safeguards.
- **Maximum:** very aggressive FFT `afftdn` noise filtering. This may remove
  quiet syllables even while the microphone's audio packets are still arriving.
- **Shadow:** DeepFilterNet3/sherpa-onnx is diagnostic comparison, **not a
  substitute for accepted DTW keywords** and does not authorize alerts.

## Visible polish in each live camera

1. Separate green **Live** video state from **Mic live / Mic connecting /
   Mic offline**. A working video is not proof of active CCTV microphone data.
2. Display read-only audio source, **last probed** audio codec and decoded PCM
   byte count; cached AAC is not falsely called the current codec after a switch
   to PCM.
3. Show which Hearing, Noise, VAD and Neural settings the **running backend
   actually reports**. Also disclose that Shadow is only a comparison.
4. Mark a keyword decision as **current** only if its timestamp is recent and
   the audio stream is healthy. No stale green ACCEPTED badge after a mic drop.
5. Show a prior candidate as **Previous result only**, with last observation
   time if available. Keep old evidence intact without presenting it as
   currently heard speech.
6. Explain `duration_mismatch` direction when available: ratio < 0.60
   suggests a too-short segment; ratio > 1.55 suggests a too-long segment.
   These are *diagnostic explanations*, not changes to acceptance criteria.
7. Surface neural-shadow errors independently of DTW results.
8. Preserve all previously committed fire-popup suppression and distant-face
   overlay changes by branching from the latest experimental commit.

## Read-only mic check

While MSDS runs, open a second PowerShell window:

```powershell
cd "C:\Users\nazar\Documents\ongoin\06102026-kws"
.\diagnose-msds-audio.cmd -CameraId slot-1 -Seconds 30
```

The `.cmd` wrapper uses process-local PowerShell
`-ExecutionPolicy Bypass`; it does not change system security settings.
It fetches only local service status and **does not record audio** or reveal
camera RTSP credentials.

Say HELP, FIRE and EMERGENCY clearly and separately during the diagnostic.

- **Zero new PCM bytes / disconnected mic:** fix the camera RTSP audio track,
  MediaMTX/FFmpeg decoder, or stream reconnect; sensitivity changes cannot
  reconstruct missing audio.
- **PCM increasing, zero new segments:** isolate denoising and VAD; check
  whether Maximum removed soft speech.
- **Segments increasing with duration mismatch:** inspect actual ratio and
  template lengths before re-enrolling or tuning; don't relax the safety veto
  without controlled negative-word tests.
- **Accepted DTW but no camera alert:** check *separate* face or fire-visual
  corroboration; avoid treating shadow KWS observations as approved alerts.

A sample of one positive keyword is not enough to evaluate system quality.
Measure false alerts, missed words and latency over controlled tests at
1, 2 and 3 meters, with fan/TV/other speech, and inspect whether the face
is actually visible. No universal "100% ambient noise cancellation" is
guaranteed by the Maximum FFmpeg parameter.

## Verify code tests and build

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd test -- --run src/test/kwsLiveDiagnostics.test.ts src/test/cameraViews.test.tsx

& ".\local-server\.venv\Scripts\python.exe" -m unittest discover -s ".\local-server\tests" -p "test_kws_far_hearing.py" -v
```

The existing GitHub CI workflow is also configured to run on this polishing
branch. Actual tests, real CCTV microphone quality, CPU performance, and
face tracing at a distance must still be verified on Windows before treating
the branch as a stable release.

## Roll back to previously working application

No `stable_branch_271026` or original experimental branch files were
modified by this polishing series.

```powershell
git switch experiment/deepfilternet-sherpa-kws-20261028
.\start-neural-kws.cmd -SkipInstall -Mode shadow -NoiseProfile maximum -HearingProfile far
```
