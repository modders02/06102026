# Experimental HELP 90% fast-accept recognition

## Requested behavior

When **HELP** is the top-ranked camera KWS candidate with
`last_candidate_confidence >= 0.900`, allow it to become an accepted
**voice keyword event** immediately without waiting for optional
Faster-Whisper. This is a user-selected KWS recognition policy, **not a
standalone emergency notification rule**.

The general classifier threshold remains 0.70. This branch adds a
separate opt-in **HELP-only** policy; FIRE, AMBULANCE, and all other
English keywords remain unchanged. Existing manual enrollment samples
are untouched.

## Safeguards

The fast path accepts HELP only if:

- `MSDS_KWS_HELP_90_FAST_ACCEPT=1` is explicitly enabled,
- HELP is the KWS **top** candidate with confidence >= 0.900,
- the original decision was `accepted`, `too_close_to_unknown`,
  or `insufficient_margin`,
- the segment has a valid target duration ratio (0.60–1.55),
- the trained UNKNOWN class is ready (the decision is **not**
  `negative_not_ready`) and HELP scores **above UNKNOWN**.

The usual 0.03 UNKNOWN gap and class margin can be bypassed for
HELP, but an UNKNOWN score equal to or greater than HELP still blocks
the fast path. A high percentage alone does not establish reliable
speech identification, particularly for noisy CCTV microphones.

For eligible HELP:

- `last_decision: accepted_help_90`
- `verification_state: skipped_help_90` (ASR was not attempted)
- `original_kws_decision` still records the normal KWS result
- `last_keyword: help`
- The normal KWS event is published for the frontend; any emergency
  snapshot/alert still needs the configured separate visual/facial
  validation. The UI must **not** label this voice recognition as
  an independently ASR-verified detection.

A score below 0.900 takes the previous path, including Whisper if
enabled. All original settings can be restored simply by stopping
the backend and setting `MSDS_KWS_HELP_90_FAST_ACCEPT=0`.

## Install and enable (Windows PowerShell)

Stop the old backend and MSDS desktop app. From your repo root:

```powershell
git fetch origin
git switch feature/kws-help-90-fast-accept-20261014
git pull --ff-only origin feature/kws-help-90-fast-accept-20261014

$env:MSDS_KWS_HELP_90_FAST_ACCEPT = "1"
$env:MSDS_KWS_VERIFY_ASR = "1"
$env:MSDS_KWS_HELP_RESCUE = "1"
$env:MSDS_KWS_SHORT_HELP_ASR = "1"
$env:MSDS_KWS_VERIFY_MODEL = "tiny.en"

& ".\local-server\.venv\Scripts\python.exe" ".\local-server\camera_server.py"
```

The Python process reads these environment variables **at runtime**.
Do not launch another copy on API port 5000; Electron can reuse
an old bridge with different environment settings.

## Live CCTV test

Say HELP once and check in a second terminal:

```powershell
$k = ((Invoke-RestMethod "http://127.0.0.1:5000/status").cameras |
      Where-Object id -eq "slot-1").audio.custom_kws
$k | Format-List last_segment_at,help_90_fast_accept_enabled,help_90_fast_accept_threshold,last_candidate,last_candidate_confidence,last_negative_confidence,original_kws_decision,verification_state,last_decision,last_keyword
```

A qualifying result should show `help_90_fast_accept_enabled: True`,
`last_decision: accepted_help_90` and `last_keyword: help`,
without `verification_pending`.

Compare fresh HELP utterances with HELLO, HEALTH, FIRE, FINE,
AMBULANCE and quiet/background TV speech, tracking accepted keywords
and rejected candidates. Keep external emergency notifications
**disabled** during testing. The percent is a similarity metric,
not a calibrated probability of a real emergency.

## Regression test

```powershell
& ".\local-server\.venv\Scripts\python.exe" -m unittest discover -s local-server/tests -p "test_kws_help_90_fast_accept.py" -v
```
