# Experimental FIRE/HELP disagreement recovery

This branch builds on the seven-word English KWS, Whisper verification,
HELP recovery, and safe MediaMTX auto-recovery. No template files are
edited. External emergency alerts and notifications must remain disabled
during research evaluation.

## The failure reproduced from CCTV diagnostics

- KWS FIRE = 0.862 (accepted), HELP = 0.809 (runner-up), UNKNOWN = 0.817.
- The HELP-specific duration ratio is 1.206.
- Whisper independently transcribes the segment as "Help!".
- Previously the FIRE candidate failed Whisper verification, which
  correctly blocked the incorrect FIRE event but also lost genuine HELP.

## Guarded change

With `MSDS_KWS_VERIFY_ASR=1` and `MSDS_KWS_HELP_RESCUE=1`:

1. The **original FIRE** candidate is checked by Whisper first.
2. If Whisper confirms FIRE, the event remains **FIRE**.
3. If Whisper disagrees and returns only `help`, the engine checks
   independent HELP evidence from the *same* KWS segment.
4. A correction to HELP is considered only for KWS-accepted FIRE with
   HELP runner-up, HELP score >=0.80, FIRE score <=0.90, score gap
   <=0.060, HELP duration ratio 0.75–1.30, and HELP minus UNKNOWN
   score between -0.015 and +0.10.
5. Only if all rules pass does a HELP event publish, at the **HELP
   KWS score** (never FIRE score). The recorded decision is
   `verified_help_rescue`, source `fire_disagreement`, and ASR target
   becomes `help`. No global KWS thresholds are changed.
6. An unavailable ASR model, a hallucinated word, a longer phrase, or
   an out-of-bounds candidate does **not** produce an event.

These gates are experimental heuristics fitted to limited observations.
ASR agreement is not proof of a real emergency. This change requires
held-out CCTV recordings and many negative-word trials. The HELP
facial-distress fusion path remains a separate safety requirement.

## Pull and start (PowerShell)

Stop any previously running Python backend before pulling:

```powershell
git fetch origin
git switch feature/kws-help-fire-disagreement-20261014
git pull --ff-only origin feature/kws-help-fire-disagreement-20261014

$env:MSDS_KWS_VERIFY_ASR = "1"
$env:MSDS_KWS_HELP_RESCUE = "1"
$env:MSDS_KWS_VERIFY_MODEL = "tiny.en"

& ".\local-server\.venv\Scripts\python.exe" ".\local-server\camera_server.py"
```

## Confirm the same new spoken segment

In another PowerShell terminal, speak HELP once and wait for ASR to finish:

```powershell
$k = ((Invoke-RestMethod "http://127.0.0.1:5000/status").cameras |
      Where-Object id -eq "slot-1").audio.custom_kws
$k | Format-List last_segment_at,last_candidate,last_runner_up_keyword,last_keyword_scores,last_keyword_duration_ratios,original_kws_decision,help_rescue_source,verification_target,verification_transcript,verification_state,last_decision,last_keyword
```

For a successful cross-word correction, you may see:

```
last_candidate          : fire
original_kws_decision   : accepted
help_rescue_source      : fire_disagreement
verification_target     : help
verification_transcript : Help!
verification_state      : verified
last_decision           : verified_help_rescue
last_keyword            : help
```

These are example diagnostics, not guaranteed outcomes. A healthy
FIRE/FIRE agreement must still report `verified` and `last_keyword=fire`.

Evaluate with at least 10 new, independent utterances per word (HELP,
FIRE, HELLO, HEALTH, FINE, AMBULANCE) and quiet/noisy backgrounds. Log
both rejections and published keyword events, plus any visual fusion.
Do not enable real dispatch before the measured false-positive and
false-negative rates meet the study's acceptance criteria.

## Tests / rollback

```powershell
& ".\local-server\.venv\Scripts\python.exe" -m unittest discover -s local-server/tests -p "test_kws_help_rescue.py" -v
```

To disable all HELP rescue paths without resetting your templates,
stop the backend and set `$env:MSDS_KWS_HELP_RESCUE="0"` before
restarting. To return to the previous experimental code, switch back
to `feature/kws-help-second-chance-20261014`.
