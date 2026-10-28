# MSDS neural KWS experiment: install Python packages and English model, then start Electron.
# Run locally from PowerShell or double-click start-neural-kws.cmd at the repo root.
# This script NEVER changes stable_branch_271026 or retrains DTW templates.
param(
  [ValidateSet("shadow", "verify")][string]$Mode = "shadow",
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
    & $venvPython -m pip show deepfilternet *> $null
    $deepFilterInstalled = ($LASTEXITCODE -eq 0)
    if (-not $deepFilterInstalled) {
      Write-Host "[MSDS] Preparing Rust/Cargo and Microsoft C++ build tools for DeepFilterLib." -ForegroundColor Yellow
      . (Join-Path $PSScriptRoot "ensure-neural-build-tools.ps1")
    }
    Invoke-Checked "Installing MSDS Python server dependencies" {
      & $venvPython -m pip install --timeout 120 --retries 10 -r (Join-Path $PSScriptRoot "requirements.txt")
    }
    Invoke-Checked "Installing CPU PyTorch (needed by DeepFilterNet3)" {
      & $venvPython -m pip install --timeout 120 --retries 10 --index-url "https://download.pytorch.org/whl/cpu" torch torchaudio
    }
    Invoke-Checked "Installing DeepFilterNet, sherpa-onnx and scipy" {
      & $venvPython -m pip install --timeout 120 --retries 10 deepfilternet sherpa-onnx scipy
    }
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
  # The model's BPE encoder expects uppercase English phrases.
  @("HELP", "FIRE", "EMERGENCY", "DANGER", "INTRUDER", "POLICE", "AMBULANCE") |
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
  $env:MSDS_KWS_NEURAL_DENOISE = "1"
  $env:MSDS_KWS_ROBUST_MODE = "off"
  $env:MSDS_KWS_AUDIO_DENOISE = "0"  # avoid double filtering; neural uses DeepFilterNet
  $env:MSDS_KWS_WEBRTC_VAD = "1"
  $env:MSDS_KWS_WEBRTC_MODE = "2"
  $env:MSDS_KWS_HELP_90_FAST_ACCEPT = "0" # do not mix acceptance shortcuts in this experiment
  $env:MSDS_SHERPA_KWS_MODEL_DIR = $modelDir

  Write-Host "[MSDS] Neural pipeline configured. Mode=$Mode. Stable DTW templates unchanged." -ForegroundColor Green
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
