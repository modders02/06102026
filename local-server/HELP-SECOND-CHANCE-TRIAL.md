# Experimental HELP second chance — exact-word ASR review

This branch inherits the **seven-keyword, English-only** CCTV KWS model,
the two-stage ASR verification trial, and safe MediaMTX automatic recovery.
It does not modify existing templates in `local-server/kws-data-v2`.

## The observed failure

With AMBULANCE newly trained, true HELP can rank narrowly behind
AMBULANCE in leave-one-out evaluation. In the observed recorded example,
AMBULANCE scored 0.916, HELP 0.911, and UNKNOWN 0.921. The earlier
HELP rescue examined only samples for which HELP was the **top** KWS
candidate, so it could never review this case.

## Controlled change (disabled unless explicitly enabled)

- Normal KWS still enforces threshold, UNKNOWN margin, per-class margin,
  and duration ratio. No global thresholds are lowered.
- The optional HELP reviewer examines (a) top-ranked HELP with a narrow
  margin/UNKNOWN rejection, or (b) **rejected AMBULANCE** with second-ranked
  HELP nearly tied, and the HELP-specific duration in the valid range.
- For case (b), HELP must score at least 0.90, be within 0.025 of AMBULANCE,
  and be no more than 0.015 behind UNKNOWN. Both candidates must come
  from already trained templates.
- The **same original CCTV speech segment** is transcribed once by
  Faster-Whisper, and ASR must return only `help`. Any disagreement,
  missing model, longer phrase, or failed check **rejects** the proposal.
- On agreement, the event is published as HELP with the **HELP KWS score**,
  never with AMBULANCE's confidence; status retains the original KWS
  diagnosis in `original_kws_decision`, the top candidate in
  `last_candidate`, and the actual checked word in `verification_target`.
- The frontend does not turn a bare HELP event into an automatic facial
  distress alert; its configured facial-evidence fusion still applies.

This is a research experiment. ASR can hallucinate short words or share
errors with KWS. Keep all emergency notification/dispatch channels off
during evaluation. Never claim full reliability from enrollment or unit
tests alone.

## Try on Windows PowerShell

Stop the old Python bridge and the MSDS desktop app first, then:

```powershell
git fetch origin
git switch feature/kws-help-second-chance-20261014
git pull --ff-only origin feature/kws-help-second-chance-20261014

$env:MSDS_KWS_VERIFY_ASR = "1"
$env:MSDS_KWS_HELP_RESCUE = "1"
$env:MSDS_KWS_VERIFY_MODEL = "tiny.en"

& ".\local-server\.venv\Scripts\python.exe" ".\local-server\camera_server.py"
```

When saying HELP into Camera 1, check the new fields in another terminal:

```powershell
$k = ((Invoke-RestMethod "http://127.0.0.1:5000/status").cameras |
       Where-Object id -eq "slot-1").audio.custom_kws
$k | Format-List last_segment_at,last_candidate,last_candidate_confidence,last_runner_up_keyword,last_runner_up_confidence,original_kws_decision,help_rescue_source,verification_target,verification_transcript,verification_state,last_decision,last_keyword
```

If the original KWS rejected AMBULANCE but narrowly ranked HELP second,
an **eligible** verified result should report:

```
last_candidate          : ambulance
original_kws_decision   : duration_mismatch
help_rescue_source      : runner_up
verification_target     : help
verification_transcript : help
last_decision           : verified_help_rescue
last_keyword            : help
```

These are examples, not guaranteed outcomes. A noneligible sample is
correctly rejected even if someone says HELP.

Use a quiet test environment and manually review at least 10 fresh
utterances each of HELP, AMBULANCE, HELLO, HEALTH, FINE, plus FIRE.
Record the last-segment timestamp to ensure you are not reading a stale
previous result. Do not retrain templates during the trial.

## Tests and rollback

```powershell
& ".\local-server\.venv\Scripts\python.exe" -m unittest discover -s local-server/tests -p "test_kws_help_rescue.py" -v
& ".\local-server\.venv\Scripts\python.exe" -m unittest discover -s local-server/tests -p "test_camera_kws.py" -v
```

Disable the new HELP reviewer by restarting with
`$env:MSDS_KWS_HELP_RESCUE = "0"`. All other KWS and ASR behavior
remains unchanged. Return to `feature/msds-safe-service-autorecovery-20261014`
for a complete branch rollback.
