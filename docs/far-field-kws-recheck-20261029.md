# Far-field HELP recheck — experimental (29 Oct 2026)

Your reported slot-1 HELP score 0.922, UNKNOWN score 0.896 and runner-up margin 0.0224 were insufficient for the unchanged open-set margin 0.03 and calibrated class margin 0.0291. Speech was captured; raising microphone sensitivity alone cannot establish the keyword.

## Behavior

The existing far VAD includes up to 200 ms of lead-in audio. For a near-miss HELP diagnosis only (original confidence >= 0.90, duration ratio 0.65–1.30, reject reason too_close_to_unknown or insufficient_margin), this experiment retries the original DTW classifier with 60 ms and 100 ms less leading context. Both independent rechecks must pass ALL existing UNKNOWN, duration, confidence and runner-up safeguards for a proposal. Only HELP is eligible.

- off: unchanged baseline, no recheck.
- shadow (default): compute proposed result but never alter alerts or original diagnosis.
- strict: permit acceptance only when BOTH rechecks pass the unchanged rules. Supervised trial only: evaluate false positives before connecting emergency notifications.

The extra matching work may increase latency. Trimming different windows can increase false positives even though existing thresholds remain unchanged. No live CCTV improvement has been established.

Only -NoiseProfile voice with -HearingProfile far uses this experiment.

## Launch and inspect

```powershell
.\start-neural-kws.cmd -SkipInstall -Mode shadow -NoiseProfile voice -HearingProfile far -FarRecheck shadow
$st = Invoke-RestMethod 'http://127.0.0.1:5000/status'
$k = ($st.cameras | Where-Object id -eq 'slot-1').audio.custom_kws
$k | Select-Object last_candidate,last_decision,original_kws_decision,far_recheck_mode,far_recheck_result,far_recheck_proposed,far_recheck_attempts,far_recheck_accepted_trims_ms,last_candidate_confidence,last_negative_confidence,last_class_margin,last_required_margin,last_duration_ratio,last_processing_ms
```

If far_recheck_proposed=True in shadow, that is a diagnostic proposal, NOT an accepted alert. Test HELP at 1, 3 and 5 meters, along with HELLO, unrelated words, silence, television voices and fan noise. Log misses, false alarms, and latency.

Strict trial (only after careful holdout testing and with external notifications disabled):

```powershell
.\start-neural-kws.cmd -SkipInstall -Mode shadow -NoiseProfile voice -HearingProfile far -FarRecheck strict
```

Restore baseline recheck off:

```powershell
.\start-neural-kws.cmd -SkipInstall -Mode shadow -NoiseProfile voice -HearingProfile far -FarRecheck off
```

## Regression tests

```powershell
& '.\local-server\.venv\Scripts\python.exe' -m unittest discover -s '.\local-server\tests' -p 'test_kws_far_recheck.py' -v
& '.\local-server\.venv\Scripts\python.exe' -m unittest discover -s '.\local-server\tests' -p 'test_kws_far_hearing.py' -v
& '.\local-server\.venv\Scripts\python.exe' -m unittest discover -s '.\local-server\tests' -p 'test_kws_voice_profile.py' -v
```

These tests are synthetic or mocked. They cannot prove recognition accuracy, alert safety, or real CCTV speed.
