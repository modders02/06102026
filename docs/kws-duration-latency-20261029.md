# KWS duration mismatch and CPU latency experiment — 29 Oct 2026

Branch: `experiment/kws-duration-latency-20261029`
Based on `fix/rtsp-audio-detection-recovery-20261029` (retains audio recovery and voice profile).

## Observed diagnostic

- `last_candidate=help` and `last_decision=duration_mismatch`: an earlier recorded segment was compared, but its extracted feature sequence was outside its enrolled template-duration range.
- `far_recheck_mode=shadow`, `far_recheck_result=not_eligible`: the existing recheck is intentionally limited to margin / UNKNOWN near misses; it does not bypass duration rejection.
- `last_processing_ms=2381.3`: one observed KWS computation took about 2.38 s; this is not a reliable average.
- `last_candidate` can be historical. Verify the camera is actively receiving PCM with `audio.bytes_received`, `audio.last_chunk_at`, and fresh `last_segment_at`.

## Non-invasive changes

1. Status includes `last_duration_direction`: `shorter_than_enrolled`, `longer_than_enrolled`, `within_range` or null. It is based on the unchanged ratio limits [0.60, 1.55].
2. `-FastDtw` enables an experimental NumPy anti-diagonal implementation for comparisons whose longer feature sequence is at least 75 frames. Short comparisons stay on the original method.
3. Without `-FastDtw`, original matcher is completely unchanged. Original stored templates, negative class, margin thresholds, duration gates, and emergency authorization are unchanged.
4. The accelerated path can have tiny floating-point roundoff differences. It has *not* been validated on actual CCTV holdout recordings or the user's computer. Do not assume recognition latency improved before measuring.

## Commands

```powershell
git fetch origin
git switch --track origin/experiment/kws-duration-latency-20261029
& '.\local-server\.venv\Scripts\python.exe' -m unittest discover -s '.\local-server\tests' -p 'test_kws_fast_dtw.py' -v
& '.\local-server\.venv\Scripts\python.exe' -m unittest discover -s '.\local-server\tests' -p 'test_kws_far_recheck.py' -v
.\start-neural-kws.cmd -SkipInstall -Mode shadow -NoiseProfile voice -HearingProfile far -FarRecheck shadow -FastDtw
```

Compare it against the baseline by stopping and restarting the application using the same command *without* `-FastDtw`.

## Status probes

```powershell
$st = Invoke-RestMethod 'http://127.0.0.1:5000/status'
$a = ($st.cameras | Where-Object id -eq 'slot-1').audio
$a | Select-Object connected,has_audio_track,bytes_received,last_chunk_at,audio_source,error
$a.custom_kws | Select-Object dtw_acceleration,last_segment_at,last_segment_ms,last_candidate,last_candidate_confidence,last_duration_ratio,last_duration_direction,last_decision,original_kws_decision,far_recheck_result,far_recheck_attempts,last_processing_ms
```

Record repeated HELP trials at 1, 3 and 5 meters and negative cases (HELLO, background speech, television). The duration direction distinguishes whether far-field segments are too short or too long; the correct remediation depends on measured direction. Repeated recognition times matter more than a single worst-case result. Keep actual emergency notifications disabled during experimental trials.

These are code-level changes only. Physical camera audio, test pass results, and the resulting speed on Windows remain to be verified.
