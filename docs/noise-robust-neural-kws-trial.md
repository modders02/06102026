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

2. Launch regular MSDS using npm.cmd run electron:dev (if not running).
   Connect CCTV Camera 1 and verify its microphone in a separate PowerShell:

       $s = Invoke-RestMethod "http://127.0.0.1:5000/status"
       ($s.cameras | Where-Object id -eq "slot-1").audio |
         Select-Object connected, thread_running, has_audio_track, audio_source

3. Run ONCE, with Internet for installation and the official model download:

       .\local-server\setup_neural_kws_windows.cmd

   Python 3.12 and a separate local-server/.neural-kws-venv are used.
   The downloaded English model is stored under neural-kws-models.
   The seven words HELP/FIRE/EMERGENCY/DANGER/INTRUDER/POLICE/AMBULANCE
   are converted into BPE tokens and do not require additional DTW enrollment.

4. Run while regular MSDS is monitoring, from a SECOND terminal:

       .\local-server\start_neural_kws_shadow.cmd --seconds 180

   Omit --seconds to listen until Ctrl+C. The observer connects to the
   LOCAL MediaMTX relay (127.0.0.1:8554), not to the remote camera directly.
   No CCTV passwords are exported, no raw audio is saved.

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
- The local CCTV relay must contain audio. The extra FFmpeg decoder uses
  additional CPU; if performance drops, stop the trial with Ctrl+C.
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
