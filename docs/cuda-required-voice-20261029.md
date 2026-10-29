# MSDS CUDA-required voice recognizer — no CPU inference fallback

Branch: `experiment/cuda-required-voice-kws-20261029` (based on `experiment/kws-duration-latency-20261029`).

## Strict hardware requirement

This branch is NVIDIA CUDA-only for the **neural voice models and live DTW recognition**. There is no GPU/CPU mode switch. Without supported NVIDIA hardware and compatible drivers/CUDA runtime, it FAILS TO START rather than silently processing keyword inference on the CPU. AMD and Intel graphics are not supported by this NVIDIA CUDA build. If no CUDA GPU exists, this dedicated branch will not run.

This is NOT literally a 100% GPU application: Windows, RTSP/FFmpeg I/O, audio PCM decoding, WebRTC VAD, NumPy feature extraction, DeepFilterNet STFT pre/postprocessing, Electron, and certain camera/facial operations still run on the CPU. No GPU architecture can avoid all CPU operations in this stack. The implementation targets the neural models and the main DTW dynamic programming/scoring calculations on CUDA.

## GPU packages, isolated environment

The launcher uses `local-server/.gpu-venv` (Python 3.12), leaving `local-server/.venv`, trained templates, stable branches and downloaded models untouched.

- PyTorch 2.5.1 and torchaudio 2.5.1 using official CUDA 12.4 wheels (matching legacy DeepFilterNet API).
- sherpa-onnx 2.0.1 CUDA 12/cuDNN9 wheel from the official sherpa wheel index; provider is hardcoded `cuda`.
- DeepFilterNet3 must initialize its neural model parameters on `cuda`; CPU initialization is a fatal error.
- All **live** DTW distances use CUDA tensors and constrained wavefront calculations; no CPU scoring fallback if CUDA fails.
- Both GPU initialization and model checks are performed by the setup script. Direct Python camera server startup also requires CUDA.

**Prerequisites:** Windows 64-bit with Python 3.12, suitable NVIDIA GPU, current NVIDIA driver, working CUDA 12.x / cuDNN9 runtime for sherpa-onnx, sufficient VRAM and disk space, plus the original app build prerequisites. GPU availability alone does not guarantee the specific sherpa wheel and driver combination works; explicit initialization tests decide.

## Resuming interrupted CUDA wheel downloads

The official Windows Python 3.12 CUDA 12.4 torch wheel is approximately
2.5 GB. Network timeouts during pip's temporary download previously restarted
the installation from the beginning. The launcher now calls
`local-server/install-cuda-torch.ps1`, which:

- Downloads the wheel from the exact official PyTorch CDN URL using
  `curl.exe --continue-at -` and connection retries.
- Keeps partial data in `local-server/.gpu-wheel-cache/*.whl.part` across
  launcher restarts, even if a transfer fails.
- Checks the downloaded wheel ZIP CRC before renaming to `*.whl`.
- Uses the verified local CUDA torch wheel with matching CUDA torchaudio.
- Preserves the wheel cache across restarts, without changing CUDA-required
  behavior or touching the existing CPU environment.

**Important:** The 1.4 GB partial download from the earlier pip failure was
in pip's temporary download area. It cannot reliably be recovered into the
new persistent cache. The *first* new download may start from zero, but a later
interruption can resume from its saved `.part` file.

Run again **without** `-SkipInstall` after fetching the updated branch:

```powershell
git pull --ff-only
.\start-neural-kws.cmd -Mode shadow -NoiseProfile voice -HearingProfile far -FarRecheck shadow
```

Do not delete `local-server/.gpu-wheel-cache` between attempts. Keep sufficient
free disk space for the downloaded wheel, extraction and installed GPU packages.
If the CDN does not support HTTP byte ranges on a particular connection, curl
will report a resume error rather than silently create a malformed wheel.
If a supposedly completed archive fails integrity validation, inspect the
connection and cache before retrying.

## Initial setup

Stop prior Electron/camera service. A server already occupying port 5000 may be CPU-based and must not be reused.

```powershell
git fetch origin
git switch --track origin/experiment/cuda-required-voice-kws-20261029
nvidia-smi
.\start-neural-kws.cmd -Mode shadow -NoiseProfile voice -HearingProfile far -FarRecheck shadow
```

First launch installs the isolated GPU environment, downloads/initializes neural models, verifies CUDA, and launches Electron. This can download large model and wheel files. There is NO `-Gpu` flag: GPU is mandatory. Subsequent launches:

```powershell
.\start-neural-kws.cmd -SkipInstall -Mode shadow -NoiseProfile voice -HearingProfile far -FarRecheck shadow
```

`-SkipInstall` does not override GPU requirements. If setup reports GPU missing, verify `nvidia-smi`, device model, driver, Python 3.12, and the CUDA/cuDNN dependencies. Do not force CPU wheel installation in this branch.

## Inspect

```powershell
$s = Invoke-RestMethod 'http://127.0.0.1:5000/status'
$s | Select-Object gpu_required,gpu_backend,python_exe
$s.cameras | ForEach-Object { $_.audio.custom_kws | Select-Object gpu_required,dtw_acceleration,neural_execution_provider,last_candidate,last_decision,last_processing_ms,neural_candidate,neural_processing_ms,neural_last_error }
```

Expected `gpu_required=True`, `dtw_acceleration=cuda_required`, `neural_execution_provider=cuda`. This is configuration/reporting; true execution is also checked by CUDA hardware and DeepFilterNet/Sherpa CUDA model preflight. Compare repeated live audio latency, false positives and HELP/HELLO recall before promotion.

## What remains unresolved

The earlier `duration_mismatch`, `too_close_to_unknown` and `insufficient_margin` are classifier/segmentation problems. CUDA does NOT remove their safeguards or guarantee recognition at 3–5 m. The CPU-to-GPU transfers and many small DTW kernels can even increase latency on slower GPUs. Real CCTV measurement is required.

**Safety:** Keep `-Mode shadow` and `-FarRecheck shadow` until controlled trials pass. Do not merge this CUDA-only research branch into production/stable. To return to the stable application, switch branches and use the existing CPU virtual environment; neither is overwritten by the isolated GPU environment.

## Tests

```powershell
& '.\local-server\.gpu-venv\Scripts\python.exe' -m unittest discover -s '.\local-server\tests' -p 'test_cuda_required_kws.py' -v
& '.\local-server\.gpu-venv\Scripts\python.exe' -m unittest discover -s '.\local-server\tests' -p 'test_kws_fast_dtw.py' -v
```

Tests may use CPU baseline for numerical comparison when run outside the server; that does not enable CPU fallback in the CUDA-required application. Real GPU startup and benchmarks must be verified on a supported NVIDIA Windows computer.
