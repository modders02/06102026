# MSDS: experimental adaptive noisy-room KWS VAD

This branch is an **audio-segmentation fix**, not a newly trained model and **not
proof of real-world accuracy**. It preserves the existing seven English keyword
templates, UNKNOWN veto, duration guard and HELP >=0.90 recognition policy.
The Python backend must be restarted to load this code.

## Why this change exists

Live CCTV diagnostics repeatedly showed 2.5-second "speech" segments in a
noisy room and ratios up to 7.873 against the median enrolled HELP duration.
The old VAD relied on a fixed 0.025 RMS threshold measured over arbitrary
FFmpeg chunks; background noise at RMS 0.035 exceeded that threshold.

The new VAD:

- Processes 20-ms PCM frames regardless of FFmpeg pipe read boundaries.
- Establishes a short baseline before allowing triggers.
- Uses a recent low-percentile background RMS for adaptive speech onset and
  speech-end thresholds, with a 60-ms onset confirmation.
- Freezes the background estimate *during* an active utterance to avoid
  adapting away genuine speech.
- Discards rather than classifies continuous maximum-length (2.5s) segments;
  after a timeout it recalibrates from the recent ambient frame window.
- Exposes `vad_noise_floor_rms`, `vad_start_rms`, `vad_end_rms` and
  `vad_max_length_drops` under each camera's `audio.custom_kws` status.
- Regenerates downstream raw-PCM timestamps from sample count. This may reduce
  `s16le` timestamp warnings but does not repair all possible upstream
  MediaMTX/libopus timestamp problems.

**Do not weaken** duration bounds, UNKNOWN comparison, KWS confidence or
multimodal/facial corroboration to force acceptance. The `last_keyword` field
is a *previous accepted* keyword, not the current candidate's verdict; use
`last_decision` and `last_segment_at` for current results.

## Local smoke test (Windows)

Keep KWS data in `local-server/kws-data-v2` on your machine; these templates
are ignored by Git and are not shipped by this branch. Back them up before any
re-enrollment.

1. Close old MSDS/Electron/Python servers so port 5000 has one owner.
2. Open the repository root in PowerShell, set the KWS policy and start
   `npm.cmd run electron:dev` (or the managed Python bridge, not both).
3. In a second terminal run:

   ```powershell
   $st = Invoke-RestMethod "http://127.0.0.1:5000/status"
   $c = $st.cameras | Where-Object id -eq "slot-1"
   $c.audio | Select-Object connected,chunks_received,error,ffmpeg_error
   $c.audio.custom_kws | Select-Object vad_last_rms,vad_noise_floor_rms,vad_start_rms,vad_end_rms,vad_max_length_drops,segments_seen,last_segment_ms,last_candidate,last_candidate_confidence,last_duration_ratio,last_decision,last_keyword
   ```

4. Run a **quiet-room silence** trial, a **noisy-room no-speech** trial, then
   genuine wake-word utterances in both conditions with the same camera.
   Capture independent, consented holdout WAVs and non-keyword utterances.
   Do not count a stale `last_keyword` as a new true positive.
5. Evaluate separate labeled, previously unseen audio for every keyword and
   UNKNOWN before claiming improved live accuracy or enabling notifications.

## Regression tests

```powershell
& ".\local-server\.venv\Scripts\python.exe" -m unittest discover -s local-server/tests -p "test_kws_noisy_vad.py" -v
& ".\local-server\.venv\Scripts\python.exe" -m unittest discover -s local-server/tests -p "test_*.py"
```

The synthetic regression suite covers stationary noise above the original
static start threshold, short voice events mixed with background, chunk
boundaries, and continuous maximum-length speech/noise. Synthetic cases do
not substitute for held-out real CCTV data; loud TVs, music and very
low-SNR speech may still be unrecognizable or rejected.
