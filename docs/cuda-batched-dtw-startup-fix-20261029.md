# CUDA startup delay and multi-second HELP DTW processing — 29 Oct 2026

Base: `experiment/cuda-required-voice-kws-20261029`. This patch does not modify stable branches, the trained HELP / UNKNOWN templates, or emergency acceptance thresholds.

## Evidence from the user's Windows launch

- NVIDIA GTX 1650; CUDA torch 2.5.1+cu124; CUDA Sherpa; DeepFilterNet3 on cuda:0; neural startup checks succeeded.
- Electron reported `/status` unavailable after its fixed 30-second timeout, but the Python bridge and MediaMTX started later and audio was captured from `rtsp://127.0.0.1:8554/cam1`.
- The real HELP detection: confidence 0.876, UNKNOWN 0.827, runner-up FIRE 0.844, `duration_ratio=4.06`, `segment=1300ms`, `decision=duration_mismatch`, `processing=4083ms`.

## Patch

1. Electron now allows up to **180 seconds** for mandatory CUDA backend startup, retaining its previous 30-second limit for non-CUDA environments. A failed/crashed backend still returns an error. This corrects the false-unavailable state when GPU initialization needs longer than 30 seconds.
2. Original CUDA matcher ran a separate, multi-diagonal GPU DP for EACH enrolled keyword/UNKNOWN template. Live diagnosis now flattens both positive and negative training references and executes **one batched CUDA matrix/DTW wavefront**. The same 260-frame cap, per-template Sakoe-Chiba bands and original duration, class margin and UNKNOWN veto apply. Original CPU scoring remains available for offline regression tests only; GPU-required runtime does not fall back to CPU.
3. Added `test_kws_cuda_batch.py` for batched positive+UNKNOWN scoring, CUDA no-fallback, CUDA numerical parity, and invalid/empty references. Added `test_cuda_startup_readiness.py` to guard the Electron readiness budget.

## Update and start

```powershell
git fetch origin
git switch --track origin/fix/cuda-startup-batched-dtw-20261029
& '.\local-server\.gpu-venv\Scripts\python.exe' -m unittest discover -s '.\local-server\tests' -p 'test_kws_cuda_batch.py' -v
& '.\local-server\.gpu-venv\Scripts\python.exe' -m unittest discover -s '.\local-server\tests' -p 'test_cuda_startup_readiness.py' -v
.\start-neural-kws.cmd -SkipInstall -Mode shadow -NoiseProfile voice -HearingProfile far -FarRecheck shadow
```

**Do not reinstall CUDA torch.** The existing `.gpu-venv` remains valid; `-SkipInstall` will still run PyTorch/DeepFilterNet3/sherpa CUDA checks and load existing keyword models. If any check fails, use normal setup (without `-SkipInstall`).

## Confirm status and timing after restart

```powershell
$st = Invoke-RestMethod 'http://127.0.0.1:5000/status'
$st | Select-Object gpu_required,gpu_backend,python_exe,error
$a = ($st.cameras | Where-Object id -eq 'slot-1').audio
$a | Select-Object has_audio_track,connected,bytes_received,audio_source,error
$a.custom_kws | Select-Object last_segment_at,last_candidate,last_candidate_confidence,last_duration_ratio,last_duration_direction,last_decision,last_processing_ms,dtw_acceleration
```

Record multiple real HELP tests at 1, 3 and 5 meters (including negative words HELLO/background speech) and compare KWS processing latency. The numerical parity test can pass without proving real-time GPU speed; kernel launch and transfer overhead vary by hardware.

### Remaining issue: very long speech segments

A 1.3-second captured segment with HELP duration ratio 4.06 is a segmentation/enrollment mismatch, not a hardware/CPU failure. It remains correctly **rejected**. This optimization deliberately does NOT accept overlong segments, trim arbitrary speech into HELP alerts, or weaken the UNKNOWN veto. Check camera microphone audio quality and VAD segmentation before changing recognition rules.

### Safety

This branch is experimental. No trained voice templates, stable branch, or external notification policy changed. GPU must initialize successfully or the app fails rather than reverting to CPU.
