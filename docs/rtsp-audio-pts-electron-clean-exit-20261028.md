# RTSP audio timestamp warnings and clean Electron close

Branch: `experiment/deepfilternet-sherpa-kws-20261028`  
Stable: `stable_branch_271026` is unchanged.

## Diagnosis from Windows console logs

```text
[FFmpeg slot-1] [libopus] Queue input is backward in time
[FFmpeg slot-1] [aost#0:1/libopus] Non-monotonic DTS; previous ... current ...
wait-on http://localhost:8080 && npm run electron:start exited with code 0
--> Sending SIGTERM to other processes..
npm run dev exited with code 1
[MSDS] Neural setup stopped: Starting MSDS Electron ... failed (exit code 1)
```

These are **two different phenomena**, not evidence that DeepFilterNet3 or
sherpa-onnx crashed:

1. The camera publisher's FFmpeg process (`[FFmpeg slot-1]`, not the
   independent `[FFmpeg audio slot-1]` KWS worker) receives irregular
   camera audio timing. The libopus encoder sees output packets that arrive
   with backward DTS; FFmpeg compensates and warns. The root of the RTSP
   timestamp irregularity may be camera firmware, capture timing, packet
   transport or buffering; the log does not identify a unique physical cause.
2. In dev mode, `concurrently -k` intentionally stops Vite when the Electron
   process exits with status **0** (normal window close). The killed Vite
   process reports status 1. The original `concurrently` default required
   both processes to exit successfully, so the PowerShell installer reported
   an erroneous startup failure after normal application shutdown.

## Changes

- The **FFmpeg RTSP publisher audio** now uses
  `-af asetpts=N/SR/TB` to construct strictly increasing audio timestamps
  from the count of decoded samples instead of reusing the camera's
  occasionally backward packet PTS. This is FFmpeg's documented
  audio-sample-based timestamp expression.
- The publisher still encodes 48-kHz mono Opus, retains  H.264 video, and
  still maps audio optionally (`0:a:0?`) for cameras without microphones.
- The independent raw 16-kHz KWS capture, DeepFilterNet3, DTW templates,
  and the validated-alert policy are not changed by this FFmpeg publisher
  filter.
- `electron:dev` now runs with `concurrently -k --success first`. When
  Electron closes successfully as the first exiting command, terminating the
  Vite server no longer makes PowerShell report a false failure. Actual
  startup failures that are the first exit still return non-zero.

## Test and run (Windows PowerShell)

```powershell
git pull --ff-only origin experiment/deepfilternet-sherpa-kws-20261028

& ".\local-server\.venv\Scripts\python.exe" -m unittest discover -s ".\local-server\tests" -p "test_rtsp_audio_timestamp.py"

.\start-neural-kws.cmd -SkipInstall
```

Check a connected CCTV's live video and audio, word spotting, and stream
health for several minutes. Compare the rate of Opus DTS warnings and
check for muted / delayed speech. The audio retiming addresses one common
cause of non-monotonic *output* timestamps; it cannot repair missing
microphone samples or all RTSP jitter.

If audio is muted or visibly out of sync after retiming, stop MSDS and
retry with the original camera timestamps:

```powershell
$env:MSDS_RTSP_AUDIO_RETIME = "0"
.\start-neural-kws.cmd -SkipInstall
```

This override is local to the current PowerShell shell and child processes;
the default is `1`. Exit and restart the application after changing it.

When you close Electron yourself, it is expected for the Vite/dev helper and
the local camera service to shut down too. It should now report a successful
normal exit. If Electron disappears by itself without a user closing it,
collect the **first error or stack trace** earlier in the log and Windows
Event Viewer / Electron main-process logs; the excerpt above by itself does
not demonstrate what caused the window to close.

There may still be **RTSP source-side** warnings because this output-side
filter does not alter the camera firmware or incoming timestamps. Do not
suppress all FFmpeg warnings or treat a clean status code as proof of full
stream integrity. Measure live A/V synchronization and KWS recall in the
same scene before deploying this experimental branch.
