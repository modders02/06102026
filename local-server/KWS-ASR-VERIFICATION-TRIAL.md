# Experimental CCTV KWS + Whisper verification

This feature is **opt-in and for controlled testing only**. Default behavior stays
as before (trained KWS alone). The original `POST /cameras/slot-1/kws-enroll/{keyword}`
manual enrollment is unchanged. All `.npy` templates stay on the local PC.
Git does not download or replace existing KWS enrollment templates.

## How it works
1. Existing VAD extracts one speech segment from the CCTV microphone.
2. Existing English-only log-Mel/DTW KWS chooses the best class and applies its
   threshold, duration, UNKNOWN and class-margin checks.
3. **Only if KWS accepts** and `MSDS_KWS_VERIFY_ASR=1`, Faster-Whisper
   transcribes the same isolated segment in English.
4. A case-insensitive, **whole-word** match of the selected keyword is required.
   A mismatch, empty transcript, missing model, decoder error, etc. blocks the
   `custom-kws` event. It does not dispatch an unverified alert.
5. Live diagnostics distinguish `verified`, `verification_mismatch`,
   `verification_no_speech`, `verification_unavailable`, etc.

The secondary model's errors can correlate with KWS errors and single short
words are difficult for general ASR. This is a trial, **not a safety guarantee**.
Keep emergency notification and dispatch features disabled during testing.

## Windows PowerShell

From repository root, with the backend **stopped**:

```powershell
git fetch origin
git switch feature/kws-asr-verification-trial-20261013
# Install the optional ASR dependency in the EXISTING local server venv.
& ".\local-server\.venv\Scripts\python.exe" -m pip install faster-whisper
$env:MSDS_KWS_VERIFY_ASR = "1"
$env:MSDS_KWS_VERIFY_MODEL = "tiny.en"   # fast first trial; compare base.en later
& ".\local-server\.venv\Scripts\python.exe" ".\local-server\camera_server.py"
```

The first ASR candidate can download the model from Hugging Face, so internet
access may be required. The model runs on CPU and can introduce noticeable
latency, especially on multiple cameras. While decoding, the camera's audio
worker is blocked; this may drop/lag subsequent speech under load. Production
deployment requires an asynchronous, bounded verification queue and measured
end-to-end latency.

Other PowerShell terminal:

```powershell
$k = ((Invoke-RestMethod "http://127.0.0.1:5000/status").cameras |
      Where-Object id -eq "slot-1").audio.custom_kws
$k | Select-Object verification_enabled,verification_model,verification_state,verification_transcript,verification_error,last_candidate,last_decision
```

Say FIRE 3x, HELP 3x, FINE 3x, FIVE and WIRE while notifications are off.
Observe whether *verified* only occurs with the intended keyword. Check
`Captured`/segment timestamps to rule out background noise and stale results.

The `last_keyword` and `last_detected_at` fields represent the **last
published/verified** event, and can be stale after later rejections. Use
`last_segment_at`, `last_candidate`, `last_decision`, and
`verification_state` for the most recent segment.

The diagnostics may briefly report `verification_unavailable` if
faster-whisper isn't installed or its model can't be loaded. Such candidates
are **blocked**, not accepted. Do not re-enable dispatch as a workaround.

Run tests from the repository root:
```powershell
& ".\local-server\.venv\Scripts\python.exe" -m unittest discover -s local-server/tests -p "test_kws_verifier.py" -v
& ".\local-server\.venv\Scripts\python.exe" -m unittest discover -s local-server/tests -p "test_camera_kws.py" -v
```

## Experimental borderline HELP recovery (opt-in)

This trial has an **additional** switch, disabled by default, to investigate
real HELP speech rejected by the normal KWS UNKNOWN/class-margin gates:

```powershell
$env:MSDS_KWS_VERIFY_ASR = "1"
$env:MSDS_KWS_HELP_RESCUE = "1"
$env:MSDS_KWS_VERIFY_MODEL = "tiny.en"
& ".\\local-server\\.venv\\Scripts\\python.exe" ".\\local-server\\camera_server.py"
```

Only a KWS candidate **already identified as HELP** and narrowly blocked by
`too_close_to_unknown` or `insufficient_margin` is considered. It must
have: confidence >=0.90; runner-up AMBULANCE; class margin >=0.015 but below
its required margin; UNKNOWN separation >=0.020; and duration ratio
0.75–1.30. The *original* 0.70, 0.03, and class-margin acceptance rules stay
unchanged for every keyword.

The verifier must transcribe the **isolated word `help`**, not merely a
phrase that contains it. Any ASR error, mismatch, missing model, ambiguous
phrase, or failure of the bounded KWS criteria still blocks the keyword
event. Successful recovery reports `last_decision=verified_help_rescue`
with `original_kws_decision` preserving the initial rejection.

`GET /status` per-camera fields now include
`help_rescue_enabled`, `original_kws_decision`,
`verification_state`, and `verification_transcript`. The last accepted
keyword can be **stale** after subsequent rejections; compare
`last_segment_at` and `last_decision`.

**Do not activate external emergency notifications for this experiment.**
Whisper is not guaranteed to distinguish a genuine one-word HELP from other
short speech, and HELP may still fail the first-stage eligibility guard.
The separate React facial-distress fusion is still necessary for HELP-related
alerts but is not validated by this change.

To disable recovery without removing the main ASR gate, restart with:
`$env:MSDS_KWS_HELP_RESCUE = "0"`. To disable all ASR verification, set
`$env:MSDS_KWS_VERIFY_ASR = "0"` as before. Changes to environment variables
require restarting the local Python server.

### Validation sequence

Use a quiet CCTV microphone and repeat at least 10 times each:
`help`, `hello`, `health`, `ambulance`, and unrelated casual speech.
Log KWS class/UNKNOWN margins, ASR transcript, `last_decision`, and whether
a fresh `custom-kws` event was actually published. Also retest FIRE/FINE.
Do not claim false-positive improvements or deployment readiness from unit
tests or one demonstration.

```powershell
& ".\\local-server\\.venv\\Scripts\\python.exe" -m unittest discover -s local-server/tests -p "test_kws_help_rescue.py" -v
```

## Rollback
Stop the backend, then switch back to
`feature/msds-next-updates-20261013`. For a quick configuration-only
rollback on this branch, start a new backend process with
`$env:MSDS_KWS_VERIFY_ASR = "0"`. Neither action edits the KWS templates.

## Known limitations
- Short isolated words may be mistranscribed (false rejects); ASR is not perfect.
- Keyword verification is linguistic only, not proof of a real-world emergency.
- This version uses synchronous ASR inference on the CCTV audio worker.
- The first trial must be evaluated using real CCTV live utterances and
  independent negative speech, not just stored-template accuracy.
