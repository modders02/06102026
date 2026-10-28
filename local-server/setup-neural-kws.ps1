# MSDS neural KWS experiment: install Python packages and English model, then start Electron.
# Run locally from PowerShell or double-click start-neural-kws.cmd at the repo root.
# This script NEVER changes stable_branch_271026 or retrains DTW templates.
param(
  [ValidateSet("shadow", "verify")][string]$Mode = "shadow",
  # This explicit experimental launcher defaults to maximum noise filtering.
  # For less aggressive KWS behavior, run -NoiseProfile strong/standard/off.
  [ValidateSet("off", "standard", "strong", "maximum")][string]$NoiseProfile = "maximum",
  # Far hearing is a VAD sensitivity change; it does not lower KWS matches.
  [ValidateSet("normal", "far")][string]$HearingProfile = "far",
  [switch]$SkipInstall,
  [switch]$NoLaunch
)
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$venvPython = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
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
  if (-not (Test-Path $venvPython)) {
    $pythonCmd = Get-Command py -ErrorAction SilentlyContinue
    if ($pythonCmd) {
      Invoke-Checked "Creating local Python environment" { py -3 -m venv (Join-Path $PSScriptRoot ".venv") }
    } else {
      Invoke-Checked "Creating local Python environment" { python -m venv (Join-Path $PSScriptRoot ".venv") }
    }
  }
  if (-not (Test-Path $venvPython)) { throw "Python venv was not created at $venvPython" }

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
    Invoke-Checked "Installing matched CPU PyTorch/torchaudio 2.5.1 for DeepFilterNet3" {
      # DeepFilterNet 0.5.6 imports torchaudio.backend.common.AudioMetaData.
      # Newer torchaudio releases removed that legacy module, causing an
      # ImportError before the enhancement model can load. Pin BOTH halves
      # to the same official PyTorch CPU release. Windows CPython 3.12
      # wheels are available for this version.
      & $venvPython -m pip install --timeout 120 --retries 10 --index-url "https://download.pytorch.org/whl/cpu" "torch==2.5.1" "torchaudio==2.5.1"
    }
    Invoke-Checked "Installing DeepFilterNet, sherpa-onnx, SciPy and keyword tokenizer dependencies" {
      # The sherpa-onnx 2.0.1 text2token function eagerly imports both
      # sentencepiece and pypinyin, EVEN with --tokens-type bpe (English).
      # Both are optional undeclared dependencies of the CLI.
      & $venvPython -m pip install --timeout 120 --retries 10 deepfilternet sherpa-onnx scipy sentencepiece pypinyin
    }
  }

  # The legacy torchaudio.backend import is required by DeepFilterNet
  # 0.5.6. Probe at every launch, including -SkipInstall, to detect a later
  # environment upgrade before downloading/loading any neural model.
  Invoke-Checked "Checking DeepFilterNet/PyTorch compatibility" {
    & $venvPython -W ignore -c "import torch, torchaudio; from torchaudio.backend.common import AudioMetaData; expected='2.5.1'; a=torch.__version__.split('+')[0]; b=torchaudio.__version__.split('+')[0]; assert a == b == expected, f'Expected matched {expected}, found torch={a}, torchaudio={b}. Rerun without -SkipInstall'; print('torch', a, '| torchaudio', b, '| DeepFilterNet legacy audio metadata: OK')"
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
  $cli = Join-Path $PSScriptRoot ".venv\Scripts\sherpa-onnx-cli.exe"
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
    Invoke-Checked "Downloading/loading DeepFilterNet3 and testing CPU enhancement" {
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
  # Also clean the AUDIO HEARD from the CCTV/WebRTC stream in Maximum mode.
  # If KWS uses that MediaMTX relay, skip repeat FFT in its PCM decoder.
  # This switch is optional so strong/standard/off retain the old playback.
  $env:MSDS_RTSP_AUDIO_DENOISE_PLAYBACK = $(if ($NoiseProfile -eq "maximum") { "1" } else { "0" })
  $env:MSDS_KWS_WEBRTC_VAD = "1"
  $env:MSDS_KWS_HEARING_PROFILE = $HearingProfile
  # WebRTC mode 1 listens more readily for quiet/far voices than mode 3.
  # Retain the prior strict mode 3 for maximum + normal, with a one-command rollback.
  $env:MSDS_KWS_WEBRTC_MODE = $(if ($HearingProfile -eq "far") { "1" } elseif ($NoiseProfile -eq "maximum") { "3" } else { "2" })
  $env:MSDS_KWS_HELP_90_FAST_ACCEPT = "0" # do not mix acceptance shortcuts in this experiment
  $env:MSDS_SHERPA_KWS_MODEL_DIR = $modelDir

  Write-Host "[MSDS] Neural mode=$Mode, FFmpeg noise=$NoiseProfile, hearing=$HearingProfile, DeepFilterNet=maximum, WebRTC VAD=$env:MSDS_KWS_WEBRTC_MODE." -ForegroundColor Green
  if ($HearingProfile -eq "far") {
    Write-Host "[MSDS] Far hearing: detects softer VAD onsets with added pre-roll; KWS confidence/UNKNOWN safety checks remain unchanged." -ForegroundColor Cyan
  }
  if ($NoiseProfile -eq "maximum") {
    Write-Host "[MSDS] Maximum also denoises audible RTSP/WebRTC audio (no duplicate FFT for MediaMTX KWS)." -ForegroundColor Cyan
    Write-Host "[MSDS] WARNING: Maximum FFT/VAD filtering can discard quiet emergency words and add A/V delay. Validate help/fire recall and lip-sync before relying on it." -ForegroundColor Yellow
  }
  Write-Host "[MSDS] Stable DTW enrollment and source branch unchanged." -ForegroundColor Green
  if (-not $NoLaunch) {
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
