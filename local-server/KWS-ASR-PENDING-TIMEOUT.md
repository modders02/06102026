# Resolving KWS verification_pending stuck in Whisper

## Cause

The camera marks a KWS candidate `verification_pending` and then calls
the optional Faster-Whisper verification synchronously. If the model is
being downloaded, loaded for the first time, or stalls on CPU decoding,
the camera's audio worker can wait indefinitely. KWS thresholds and
re-enrollment cannot fix a hung verification call.

## Change in this experimental branch

- A verification attempt has a **12-second default timeout** (set
  `MSDS_KWS_VERIFY_TIMEOUT_SECONDS` to 2–60 seconds to override).
- After timeout the decision becomes `verification_timeout` instead of
  staying pending indefinitely. **No speech event/alert is published**.
- The old decoding thread may still finish asynchronously; its **late
  response is discarded**, and can never publish a stale emergency event.
- While the decoder or first-run model download is still active, any
  additional verification fails closed with `verification_busy`. Only
  **one** worker may run across all cameras, preventing runaway threads.
- Once the model load completes, subsequent speech can be verified
  normally. Active KWS enrollment templates are untouched.
- `/status` exposes `verification_timeout_seconds`,
  `verification_in_flight`, `verification_error`, and the previous
  raw Whisper diagnostics; UI shows actionable rejection messages.
- The audio worker may still be delayed by up to the configured timeout
  because this is a bounded wait, not a fully asynchronous audio pipeline.
  Test throughput, especially with multiple cameras.

## Windows setup

Stop the running Python server **and** the MSDS desktop app first. From
the project root:

```powershell
git fetch origin
git switch feature/kws-asr-pending-timeout-20261014
git pull --ff-only origin feature/kws-asr-pending-timeout-20261014

$env:MSDS_KWS_VERIFY_ASR = "1"
$env:MSDS_KWS_HELP_RESCUE = "1"
$env:MSDS_KWS_SHORT_HELP_ASR = "1"
$env:MSDS_KWS_VERIFY_TIMEOUT_SECONDS = "12"
$env:MSDS_KWS_VERIFY_MODEL = "tiny.en"

& ".\local-server\.venv\Scripts\python.exe" ".\local-server\camera_server.py"
```

Try `tiny.en` initially: it generally has lower CPU/memory cost than
`base.en`. After establishing a baseline, `base.en` may be tested
separately; it can require a one-time download and may run slower.
Neither model is guaranteed to recognize all short CCTV utterances.

## Diagnose

After saying HELP into Camera 1, wait 12–15 seconds and check:

```powershell
$k = ((Invoke-RestMethod "http://127.0.0.1:5000/status").cameras |
      Where-Object id -eq "slot-1").audio.custom_kws
$k | Format-List last_segment_at,last_candidate,original_kws_decision,verification_model,verification_timeout_seconds,verification_in_flight,verification_target,verification_transcript,verification_raw_transcript,verification_no_speech_prob,verification_avg_logprob,verification_state,verification_error,last_decision,last_keyword
```

- `verified` / `verified_help_rescue`: both relevant gates passed.
- `verification_no_speech`: Whisper returned no usable text.
- `verification_timeout`: model loading or inference exceeded budget;
  inspect `verification_in_flight` and backend console.
- `verification_busy`: an earlier Whisper attempt is still running;
  new attempts are safely rejected until it completes.
- `verification_unavailable`: missing dependency/model or decoder error.

The timeout protects the status and prevents an alert but **does not
terminate a blocked model download**. If `verification_in_flight`
remains true for minutes, stop the bridge, check connectivity/model
caching and dependencies, then restart. A new model's first download
may require more than 12 seconds.

Unit tests:

```powershell
& ".\local-server\.venv\Scripts\python.exe" -m unittest discover -s local-server/tests -p "test_kws_asr_timeout.py" -v
```

Keep **external emergency alerts disabled** until real CCTV speech,
negative examples, latency and repeated-detection tests pass. The
previous experimental branch is
`feature/kws-short-help-asr-diagnostics-20261014`.
