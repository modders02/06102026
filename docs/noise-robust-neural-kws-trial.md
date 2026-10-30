# MSDS noisy-room keyword recognition — neural shadow trial

Branch: experiment/noise-robust-neural-kws-20261030
Base: design/premium-landing-page-20261029
Stage: **read-only neural comparison**, NOT a trained replacement or alarm source.

MSDS currently reads CCTV microphone PCM using its enrolled 16 kHz Log-Mel
and DTW templates plus negative examples. ALL EXISTING KWS DATA REMAINS INTACT.

This optional process uses a pretrained sherpa-onnx English Zipformer KWS
model with custom words. It compares neural detections to the latest DTW
diagnostic snapshot but DOES NOT send neural decisions into the MSDS alert,
enrollment, Event History, camera, or safety-fusion APIs.

Official model documentation:
https://k2-fsa.github.io/sherpa/onnx/kws/pretrained_models/

English model: sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01
Official release: https://github.com/k2-fsa/sherpa-onnx/releases/tag/kws-models

## Windows — controlled trial

1. Get branch, preserving any tracked work and all untracked GPU/KWS files:

       git fetch origin
       git switch --track origin/experiment/noise-robust-neural-kws-20261030

2. First, stop the previous MSDS desktop AND the previous local camera
   bridge listening on :5000. The updated backend is required for the
   opt-in PCM feed; an Electron restart does not replace an already running
   backend process. From a NEW PowerShell in the project root, start MSDS
   with this explicit temporary experimental environment switch:

       $env:MSDS_KWS_SHADOW_PCM = "1"
       npm.cmd run electron:dev

   This enables ONE localhost-only, read-only, 16 kHz mono PCM subscription
   per camera. It is disabled by default on other runs and on other branches.
   Connect CCTV Camera 1 and verify its microphone and tap:

       $s = Invoke-RestMethod "http://127.0.0.1:5000/status"
       ($s.cameras | Where-Object id -eq "slot-1").audio |
         Select-Object connected, thread_running, has_audio_track, audio_source, neural_shadow_pcm

   Expected: connected=True, thread_running=True, neural_shadow_pcm.enabled=True.
   If enabled is missing or False, the old camera backend is still running,
   or MSDS was launched without the opt-in environment variable. Check
   the owner of port 5000 and stop ONLY the old MSDS backend, not unrelated
   Python processes:

       Get-NetTCPConnection -LocalPort 5000 -State Listen |
         Select-Object OwningProcess

   Once the backend is fully stopped, relaunch from the PowerShell session
   with MSDS_KWS_SHADOW_PCM=1 as shown above.

3. Run ONCE, with Internet for installation and the official model download:

       .\local-server\setup_neural_kws_windows.cmd

   Python 3.12 and a separate local-server/.neural-kws-venv are used.
   The downloaded English model is stored under neural-kws-models.
   The seven words HELP/FIRE/EMERGENCY/DANGER/INTRUDER/POLICE/AMBULANCE
   are converted into BPE tokens and do not require additional DTW enrollment.

4. Run while regular MSDS is monitoring, from a SECOND terminal:

       .\local-server\start_neural_kws_shadow.cmd --seconds 180

   Omit --seconds to listen until Ctrl+C. By default, the observer
   receives the SAME decoded microphone PCM used by the existing DTW engine,
   through an opt-in loopback-only HTTP feed. This avoids opening a separate
   RTSP session, and still works when the camera bridge uses direct RTSP
   audio rather than MediaMTX. No CCTV passwords or raw audio are logged.
   The bounded feed is discarded when the client disconnects and is never
   stored on disk.

   For diagnosing the OLD relay-only path explicitly, run:

       .\local-server\start_neural_kws_shadow.cmd --source rtsp --seconds 20

   This mode now prints FFmpeg's exit code, byte count, and final stderr
   instead of an endless generic "audio ended" loop. It is diagnostic, not
   recommended for routine comparisons.

5. For comparison, test the same camera and distance in the following order:
   - 30 seconds quiet ordinary speech without emergency keywords
   - 30 seconds steady fan/TV background without keywords
   - Each of the seven keywords spoken 5 times in quiet
   - Each of the seven keywords spoken 5 times with typical indoor noise
   - Repeat at a farther distance with similar vocal effort

   Temporarily disable external emergency notification delivery during
   controlled tests. Record manually the true spoken word, local time,
   noise condition, distance, and whether the detector triggered.
   Do not assume a neural result is correct.

6. Results are saved only as JSONL diagnostic metadata in the ignored
   local-server/neural-kws-results directory. To show recent events:

       Get-ChildItem .\local-server\neural-kws-results\*.jsonl |
         Sort-Object LastWriteTime -Descending |
         Select-Object -First 1 |
         Get-Content -Tail 20

   The DTW snapshot is the latest available status and may NOT correspond
   to the identical utterance, since the recognizers run asynchronously.

## Limitations

- The neural model is PRETRAINED. This trial tests whether an existing
  model works better with noisy speech; it does not fine-tune a new model.
- The backend PCM feed must be explicitly enabled when starting the
  camera bridge. It is restricted to loopback CLI requests with no browser
  Origin, one listener per camera, and no persisted audio; test only with
  permission from any people whose audio is captured. It does not introduce
  an additional FFmpeg decoder. When using --source rtsp, an audio-enabled
  relay is still necessary and the extra decoder consumes CPU.
- The stream endpoint is experimental and not a replacement for production
  access controls. Disable it by clearing the environment variable and
  restarting the backend after testing.
- No result here changes HELP/POLICE/INTRUDER or other enrolled templates.
- The main application continues to accept/reject DTW words with its own
  unknown veto and facial/visual validation. Shadow words cannot alert.
- Model results are predictions, not a guarantee of accurate emergency
  recognition or safe human decision-making.

## Read-only unit tests without downloading any neural model

       py -3.12 -m unittest discover -s .\local-server\tests -p test_neural_kws_trial.py -v

## Next stage: controlled noise augmentation + true training

After this baseline, collect a separately labeled, consenting speaker
training dataset and a held-out test dataset containing:
- True emergency-word recordings from different speakers, distances, rooms
- Silence, TV speech, fans, traffic, and near-miss negative expressions
- Noise-mixed variants at controlled SNRs and room reverberation

Evaluate false alarms/hour, per-word recall, error rates and latency for
quiet and noisy samples. Keep every augmented derivative of a source
recording within ONE data split to prevent train/test leakage.

Only if the results are better should a separate trained classifier or
an explicitly reviewed DTW + neural verification gate be considered.
Any change to live alert authority needs safety regression tests first.
