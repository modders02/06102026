# Short HELP ASR diagnostics and conservative decode review

The seven English keywords, manual CCTV enrollment templates, normal KWS
thresholds, MediaMTX recovery, and the previous HELP/FIRE recovery paths
are preserved. **This is a controlled research experiment only.**

## Why HELP can reach ASR but still fail

An example camera segment produced:
`last_candidate=help`, `original_kws_decision=insufficient_margin`,
`help_rescue_source=primary`, `verification_target=help`, but
`verification_no_speech` and an empty transcript. The KWS candidate
was suitable for the existing opt-in HELP rescue; the second-stage
Whisper decoder did not supply usable text.

The earlier verifier discarded any Whisper output with
`no_speech_prob > 0.6`, **even if** the decoding log probability was
strong. Very short speech can produce high no-speech probability. We
cannot know whether this explains a given empty transcript without
recording its raw decoded text and confidence.

## Experimental change (opt-in)

Set all three switches together:

```powershell
$env:MSDS_KWS_VERIFY_ASR = "1"
$env:MSDS_KWS_HELP_RESCUE = "1"
$env:MSDS_KWS_SHORT_HELP_ASR = "1"
$env:MSDS_KWS_VERIFY_MODEL = "base.en"
```

- For **HELP** only, and only when its speech segment is <= 800 ms,
  allow the decoder to return text even if its silence classifier is
  high. Postfilter that text more carefully.
- A high no-speech score (>0.6) can be overridden **only when**
  `avg_logprob >= -0.45` and text exists. Weak decoded text,
  mismatches, missing models, and silence still fail closed.
- Existing eligible HELP rescue needs the **isolated word** `help`.
- **FIRE** and all other keywords retain their original filters.
- There are **no new speech templates and no global threshold changes**.
- This does not invent audio that was clipped by the CCTV/VAD
  segmenter. If Whisper returns no text at all, it still rejects.

The per-camera `custom_kws` status includes:
`short_help_asr_enabled`, `verification_raw_transcript`,
`verification_no_speech_prob`, and `verification_avg_logprob`.
This allows distinguishing a **filtered transcript** from a
**genuinely empty decoder response**.

## Windows procedure

Close the existing MSDS app and stop its Python bridge, then:

```powershell
git fetch origin
git switch feature/kws-short-help-asr-diagnostics-20261014
git pull --ff-only origin feature/kws-short-help-asr-diagnostics-20261014

$env:MSDS_KWS_VERIFY_ASR = "1"
$env:MSDS_KWS_HELP_RESCUE = "1"
$env:MSDS_KWS_SHORT_HELP_ASR = "1"
$env:MSDS_KWS_VERIFY_MODEL = "base.en"

& ".\local-server\.venv\Scripts\python.exe" ".\local-server\camera_server.py"
```

`base.en` is more expensive than `tiny.en` and may require a
first-use model download. It is a trial choice, **not a proven
accuracy guarantee**. Use CPU time/latency measurements before
shipping the model or activating emergency notifications.

In a separate PowerShell terminal, say HELP into Camera 1, then:

```powershell
$k = ((Invoke-RestMethod "http://127.0.0.1:5000/status").cameras |
      Where-Object id -eq "slot-1").audio.custom_kws
$k | Format-List last_segment_at,verification_model,short_help_asr_enabled,last_candidate,original_kws_decision,help_rescue_source,verification_target,verification_state,verification_transcript,verification_raw_transcript,verification_no_speech_prob,verification_avg_logprob,last_decision
```

An eligible ASR-confirmed HELP rescue reports
`last_decision=verified_help_rescue`. If `verification_raw_transcript`
is empty, the decoder supplied no text; try observing the raw CCTV
audio/VAD segmentation rather than weakening the speech gates.

Do a minimum of ten fresh trials per target for HELP, HELLO, HEALTH,
FINE, FIRE, and AMBULANCE while **external emergency alerts are
disabled**. A single HELP recovery is not proof of accuracy.
Do not use this experimental mode for unattended emergency dispatch.

## Unit tests and rollback

```powershell
& ".\local-server\.venv\Scripts\python.exe" -m unittest discover -s local-server/tests -p "test_kws_short_help_asr.py" -v
```

To disable short-word review while keeping the previous two-stage
feature, stop and restart the backend with
`$env:MSDS_KWS_SHORT_HELP_ASR = "0"`. You can also return to the prior
branch `feature/kws-help-fire-disagreement-20261014`. Neither action
alters the local KWS templates.
