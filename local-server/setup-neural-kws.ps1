# MSDS neural KWS experiment: install Python packages and English model, then start Electron.
# Run locally from PowerShell or double-click start-neural-kws.cmd at the repo root.
# This script NEVER changes stable_branch_271026 or retrains DTW templates.
param(
  [ValidateSet("shadow", "verify")][string]$Mode = "shadow",
  # This explicit experimental launcher defaults to maximum noise filtering.
  # For speech-preserving KWS behavior, run -NoiseProfile voice.
  [ValidateSet("off", "standard", "strong", "maximum", "voice")][string]$NoiseProfile = "maximum",
  # Far hearing is a VAD sensitivity change; it does not lower KWS matches.
  [ValidateSet("normal", "far")][string]$HearingProfile = "far",
  # Additional HELP re-evaluation: default shadow never changes alert outcomes.
  [ValidateSet("off", "shadow", "strict")][string]$FarRecheck = "shadow",
  [switch]$SkipInstall,
  [switch]$NoLaunch
)
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
# A separate GPU virtual environment prevents replacing the existing CPU
# environment or changing stable-branch dependencies.
$venvPython = Join-Path $PSScriptRoot ".gpu-venv\Scripts\python.exe"
$env:MSDS_REQUIRE_CUDA = "1"
$env:MSDS_PYTHON_EXE = $venvPython
$modelsDir = Join-Path $PSScriptRoot "models"
$modelName = "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01"
$modelDir = Join-Path $modelsDir $modelName
$archive = Join-Path $modelsDir ($modelName + ".tar.bz2")
$release = "https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/" + $modelName + ".tar.bz2"

function Invoke-Checked([string]$Description, [scriptblock]$Action) {
  Write-Host ("[MSDS] " + $Description) -ForegroundColor Cyan
  & $Action
  if ($LASTEXITCODE -ne 0) { throw "$Description failed (exit code $LASTEXITCODE)." }
}

Push-Location $root
try {
  if (-not (Get-Command nvidia-smi -ErrorAction SilentlyContinue)) {
    throw "GPU-only MSDS needs NVIDIA drivers and nvidia-smi. NVIDIA CUDA hardware is mandatory; no CPU fallback."
  }
  $detectedGpu = & nvidia-smi --query-gpu=name --format=csv,noheader
  if ($LASTEXITCODE -ne 0 -or -not $detectedGpu) {
    throw "No working NVIDIA CUDA GPU was detected. GPU-only mode cannot start."
  }
  Write-Host "[MSDS] CUDA-required GPU hardware: $($detectedGpu | Select-Object -First 1)" -ForegroundColor Green
  if (-not (Test-Path $venvPython)) {
    if ($SkipInstall) { throw "GPU environment not installed; first run without -SkipInstall to create the isolated .gpu-venv." }
    if (-not (Get-Command py -ErrorAction SilentlyContinue)) {
      throw "Python 3.12 launcher (py.exe) missing. Install 64-bit Python 3.12 first."
    }
    Invoke-Checked "Creating isolated CUDA Python 3.12 environment" {
      py -3.12 -m venv (Join-Path $PSScriptRoot ".gpu-venv")
    }
  }
  if (-not (Test-Path $venvPython)) { throw "GPU virtual environment was not created at $venvPython" }

  if (-not $SkipInstall) {
    # On Windows deepfilterlib 0.5.6 is source-distributed. It cannot build
    # without rustc/Cargo and the Microsoft MSVC/Windows SDK linker.
    # Do NOT retry the pip install until its native prerequisites are present.
    # pip show writes "WARNING: Package(s) not found" to stderr, which
    # PowerShell can promote to a terminating exception under Stop.
    # Return a normal zero-exit textual result for either condition instead.
    # Check both wheels: DeepFilterLib's native extension was the failure.
    $packageState = & $venvPython -c "import importlib.metadata as m; names={str(d.metadata.get('Name','')).lower() for d in m.distributions()}; print('installed' if {'deepfilternet','deepfilterlib'} <= names else 'missing')"
    if ($LASTEXITCODE -ne 0) { throw "Could not inspect the active Python environment." }
    $deepFilterInstalled = ($packageState -eq "installed")
    if (-not $deepFilterInstalled) {
      Write-Host "[MSDS] Preparing Rust/Cargo and Microsoft C++ build tools for DeepFilterLib." -ForegroundColor Yellow
      . (Join-Path $PSScriptRoot "ensure-neural-build-tools.ps1")
    }
    Invoke-Checked "Installing MSDS Python server dependencies" {
      & $venvPython -m pip install --timeout 120 --retries 10 -r (Join-Path $PSScriptRoot "requirements.txt")
    }
    Invoke-Checked "Installing DeepFilterNet, SciPy and English keyword dependencies" {
      & $venvPython -m pip install --timeout 120 --retries 10 deepfilternet scipy sentencepiece pypinyin
    }
    Invoke-Checked "Installing required matched CUDA 12.4 torch/torchaudio 2.5.1" {
      & $venvPython -m pip install --timeout 120 --retries 10 --index-url "https://download.pytorch.org/whl/cu124" "torch==2.5.1" "torchaudio==2.5.1"
    }
    Invoke-Checked "Installing CUDA-enabled sherpa-onnx (CUDA 12 / cuDNN 9)" {
      & $venvPython -m pip install --timeout 120 --retries 10 "sherpa-onnx==2.0.1+cuda12.cudnn9" -f "https://k2-fsa.github.io/sherpa/onnx/cuda.html"
    }
  }

  # The legacy torchaudio.backend import is required by DeepFilterNet
  # 0.5.6. Probe at every launch, including -SkipInstall, to detect a later
  # environment upgrade before downloading/loading any neural model.
  Invoke-Checked "Checking CUDA-only PyTorch, matching torchaudio and CUDA compute" {
    & $venvPython -W ignore -c "import torch, torchaudio; from torchaudio.backend.common import AudioMetaData; v='2.5.1'; assert torch.__version__.split('+')[0]==torchaudio.__version__.split('+')[0]==v; assert '+cu' in torch.__version__ and '+cu' in torchaudio.__version__, 'CPU-only torch detected; reinstall CUDA packages without -SkipInstall'; assert torch.cuda.is_available(), 'NVIDIA CUDA unavailable in torch'; t=torch.ones((2,2),device='cuda'); assert (t@t).sum().item()==8; print('GPU:',torch.cuda.get_device_name(0),'| torch:',torch.__version__,'| torchaudio:',torchaudio.__version__)"
  }
  Invoke-Checked "Checking sherpa CUDA wheel rather than CPU-only package" {
    & $venvPython -c "import sherpa_onnx; v=sherpa_onnx.__version__; assert '+cuda12.cudnn9' in v, f'CPU-only or incorrect sherpa version: {v}'; print('sherpa-onnx GPU:', v)"
  }

  # Keyword generation must also work with -SkipInstall. Check it up front
  # rather than failing deep inside sherpa-onnx-cli after model extraction.
  Invoke-Checked "Checking sherpa-onnx BPE tokenizer dependencies" {
    & $venvPython -c "import sentencepiece, pypinyin; print('SentencePiece:', sentencepiece.__version__, '| pypinyin:', pypinyin.__version__)"
  }

  New-Item -ItemType Directory -Force -Path $modelsDir | Out-Null
  $required = @(
    "tokens.txt", "bpe.model",
    "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
    "decoder-epoch-12-avg-2-chunk-16-left-64.onnx",
    "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx"
  )
  $missing = @($required | Where-Object { -not (Test-Path (Join-Path $modelDir $_)) })
  if ($missing.Count -gt 0) {
    Write-Host "[MSDS] Downloading official English sherpa-onnx KWS Zipformer model" -ForegroundColor Cyan
    Invoke-WebRequest -Uri $release -OutFile $archive -UseBasicParsing
    if (-not (Test-Path $archive)) { throw "English KWS model archive was not downloaded." }
    Invoke-Checked "Extracting English KWS model" { tar -xf $archive -C $modelsDir }
    Remove-Item -LiteralPath $archive -Force
  }
  foreach ($item in $required) {
    if (-not (Test-Path (Join-Path $modelDir $item))) {
      throw "English model file missing: $item. Do not start neural verification."
    }
  }

  $keywordsRaw = Join-Path $modelDir "msds_keywords_raw.txt"
  $keywordsFile = Join-Path $modelDir "msds_keywords.txt"
  # Use explicit @WORD labels so the neural recognizer can return the
  # original emergency word rather than an internal BPE token sequence.
  # sherpa-onnx text2token preserves @labels in the output.
  @("HELP @HELP", "FIRE @FIRE", "EMERGENCY @EMERGENCY",
    "DANGER @DANGER", "INTRUDER @INTRUDER", "POLICE @POLICE",
    "AMBULANCE @AMBULANCE") |
    Set-Content -Path $keywordsRaw -Encoding ASCII
  $cli = Join-Path $PSScriptRoot ".gpu-venv\Scripts\sherpa-onnx-cli.exe"
  if (-not (Test-Path $cli)) {
    $command = Get-Command sherpa-onnx-cli -ErrorAction SilentlyContinue
    if ($command) { $cli = $command.Source }
  }
  if (-not (Test-Path $cli)) {
    throw "sherpa-onnx-cli was not installed. Check the sherpa-onnx wheel for your Python version."
  }
  Invoke-Checked "Creating seven MSDS English neural keyword tokens" {
    & $cli text2token --tokens (Join-Path $modelDir "tokens.txt") `
      --tokens-type bpe --bpe-model (Join-Path $modelDir "bpe.model") `
      $keywordsRaw $keywordsFile
  }
  if ((-not (Test-Path $keywordsFile)) -or ((Get-Content $keywordsFile).Count -lt 7)) {
    throw "Keyword token conversion failed; refusing to launch experimental neural mode."
  }
  Push-Location $PSScriptRoot
  try {
    Invoke-Checked "Loading sherpa-onnx English model" {
      & $venvPython -c "from msds.neural_kws_trial import _load_spotter; _load_spotter(); print('sherpa-onnx: ready')"
    }
    Invoke-Checked "Loading DeepFilterNet3 on CUDA and testing GPU enhancement" {
      & $venvPython -c "import numpy as np; from msds.neural_kws_trial import _enhance_16k; x=_enhance_16k(np.zeros(16000,dtype=np.float32)); assert len(x)==16000; print('DeepFilterNet3: ready')"
    }
  } finally { Pop-Location }

  $env:MSDS_KWS_NEURAL_MODE = $Mode
  # DeepFilterNet3 uses full model suppression (no attenuation limit) on
  # neural shadow/verify segments. It does not run before the live VAD.
  $env:MSDS_KWS_NEURAL_DENOISE = "1"
  $env:MSDS_KWS_NEURAL_STRENGTH = "maximum"
  # The live DTW/VAD path reads these FFmpeg-filtered PCM samples.
  # Maximum is opt-in to THIS experimental launcher, never stable_branch.
  $env:MSDS_KWS_ROBUST_MODE = $NoiseProfile
  $env:MSDS_KWS_AUDIO_DENOISE = "0" # robust_mode enables denoise when not off
  $env:MSDS_KWS_NOISE_PROFILE = $NoiseProfile
  # Also clean the AUDIO HEARD from the CCTV/WebRTC stream in Maximum/voice mode.
  # If KWS uses that MediaMTX relay, skip repeat FFT in its PCM decoder.
  # This switch is optional so strong/standard/off retain the old playback.
  $env:MSDS_RTSP_AUDIO_DENOISE_PLAYBACK = $(if ($NoiseProfile -in @("maximum", "voice")) { "1" } else { "0" })
  $env:MSDS_KWS_WEBRTC_VAD = "1"
  $env:MSDS_KWS_HEARING_PROFILE = $HearingProfile
  $env:MSDS_KWS_FAR_RECHECK = $FarRecheck
  $env:MSDS_KWS_FAST_DTW = "0"  # CUDA DTW is unconditional; NumPy accelerator is not used
  # WebRTC mode 1 listens more readily for quiet/far voices than mode 3.
  # Retain the prior strict mode 3 for maximum + normal, with a one-command rollback.
  $env:MSDS_KWS_WEBRTC_MODE = $(if ($HearingProfile -eq "far") { "1" } elseif ($NoiseProfile -eq "maximum") { "3" } else { "2" })
  $env:MSDS_KWS_HELP_90_FAST_ACCEPT = "0" # do not mix acceptance shortcuts in this experiment
  $env:MSDS_SHERPA_KWS_MODEL_DIR = $modelDir

  Write-Host "[MSDS] Neural mode=$Mode, FFmpeg noise=$NoiseProfile, hearing=$HearingProfile, DeepFilterNet=maximum, WebRTC VAD=$env:MSDS_KWS_WEBRTC_MODE." -ForegroundColor Green
  if ($HearingProfile -eq "far") {
    Write-Host "[MSDS] Far hearing: detects softer VAD onsets with added pre-roll; KWS confidence/UNKNOWN safety checks remain unchanged." -ForegroundColor Cyan
  }
  if ($NoiseProfile -eq "voice") {
    Write-Host "[MSDS] Voice profile: reduced spectral attenuation and wider speech band for far-field capture; verify on actual CCTV audio." -ForegroundColor Cyan
  }
  if ($NoiseProfile -eq "maximum") {
    Write-Host "[MSDS] Maximum also denoises audible RTSP/WebRTC audio (no duplicate FFT for MediaMTX KWS)." -ForegroundColor Cyan
    Write-Host "[MSDS] WARNING: Maximum FFT/VAD filtering can discard quiet emergency words and add A/V delay. Validate help/fire recall and lip-sync before relying on it." -ForegroundColor Yellow
  }
  Write-Host "[MSDS] Far-field keyword recheck=$FarRecheck (shadow is diagnostic-only; strict is experimental and needs holdout validation)." -ForegroundColor Cyan
  Write-Host "[MSDS] GPU-required: NVIDIA CUDA for DTW, DeepFilterNet3 and sherpa-onnx; no CPU inference fallback." -ForegroundColor Green
  Write-Host "[MSDS] Stable DTW enrollment and source branch unchanged." -ForegroundColor Green
  if (-not $NoLaunch) {
    # Electron reuses an already-running local bridge. Never permit a stale
    # CPU bridge on port 5000 to masquerade as the mandatory CUDA backend.
    try {
      $oldStatus = Invoke-RestMethod "http://127.0.0.1:5000/status" -TimeoutSec 2 -ErrorAction Stop
      if ($oldStatus -and $oldStatus.cameras) {
        $notGpu = @($oldStatus.cameras | Where-Object {
          $_.audio.custom_kws.gpu_required -ne $true
        })
        if ($notGpu.Count -gt 0) {
          throw "Existing CPU camera bridge on port 5000. Close the old app/server before launching GPU-only MSDS."
        }
      }
    } catch {
      if ($_.Exception.Message -match "Existing CPU camera bridge") { throw }
      # No running bridge is the normal startup case.
    }
    if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
      throw "Node.js/npm is missing. Install Node.js LTS, then rerun this script."
    }
    if (-not (Test-Path (Join-Path $root "node_modules"))) {
      Invoke-Checked "Installing existing application dependencies" { npm.cmd ci }
    }
    Invoke-Checked "Starting MSDS Electron with neural $Mode mode" { npm.cmd run electron:dev }
  }
} catch {
  Write-Host ("[MSDS] Neural setup stopped: " + $_.Exception.Message) -ForegroundColor Red
  Write-Host "[MSDS] No stable source branch, existing DTW templates, or alerts were overwritten." -ForegroundColor Yellow
  exit 1
} finally {
  Pop-Location
}
