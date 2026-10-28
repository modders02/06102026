# MSDS stable-derived RNNoise voice isolation setup (never changes the stable branch).
param(
  [ValidateSet("off", "balanced", "maximum")][string]$VoiceMode = "maximum",
  [switch]$NoLaunch
)
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$modelDir = Join-Path $PSScriptRoot "models\rnnoise"
$modelPath = Join-Path $modelDir "sh.rnnn"
# Pinned archive source commit and original model Git blob SHA.
$modelCommit = "0fda24c46d78f0207d820bb970fbe85c1971b39c"
$modelBlobSHA = "f86e9efd3d78ec91b2d18cfd2262fe991fcb1d35"
$modelUrl = "https://raw.githubusercontent.com/richardpl/arnndn-models/$modelCommit/sh.rnnn"

function Run-Checked([string]$What, [scriptblock]$Action) {
  Write-Host "[MSDS] $What" -ForegroundColor Cyan
  & $Action
  if ($LASTEXITCODE -ne 0) { throw "$What failed (exit $LASTEXITCODE)" }
}

Push-Location $root
try {
  $ffmpegCandidates = @((Join-Path $PSScriptRoot "bin\ffmpeg.exe"), (Join-Path $PSScriptRoot "ffmpeg.exe"))
  $ffmpeg = @($ffmpegCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1)
  if ($ffmpeg.Count -gt 0) {
    $ffmpeg = $ffmpeg[0]
  } else {
    $ffmpegCmd = Get-Command ffmpeg.exe -ErrorAction SilentlyContinue
    if (-not $ffmpegCmd) { $ffmpegCmd = Get-Command ffmpeg -ErrorAction SilentlyContinue }
    if (-not $ffmpegCmd) {
      throw "FFmpeg not found. Run local-server\get_binaries.bat or install FFmpeg on PATH."
    }
    $ffmpeg = $ffmpegCmd.Source
  }
  Write-Host "[MSDS] Selected FFmpeg: $ffmpeg" -ForegroundColor Cyan
  $env:FFMPEG_EXE = [string]$ffmpeg

  if ($VoiceMode -ne "off") {
    $filters = & $ffmpeg -hide_banner -filters 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0 -or $filters -notmatch '(?m)^\s*[TSC\.]{3}\s+arnndn\s') {
      throw "This FFmpeg build does not provide the arnndn neural speech filter. The original application is unchanged; select -VoiceMode off or install full FFmpeg."
    }
    New-Item -ItemType Directory -Force -Path $modelDir | Out-Null
    if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) {
      throw "Git is required to verify the pinned RNNoise model integrity."
    }
    $valid = $false
    if (Test-Path $modelPath) {
      $blob = (& git.exe hash-object -- $modelPath | Out-String).Trim()
      $valid = $LASTEXITCODE -eq 0 -and $blob -eq $modelBlobSHA
    }
    if (-not $valid) {
      Write-Host "[MSDS] Downloading pinned RNNoise speech model (approximately 291 KB)." -ForegroundColor Cyan
      $tmp = Join-Path $modelDir "sh.rnnn.download"
      try {
        Invoke-WebRequest -Uri $modelUrl -OutFile $tmp -UseBasicParsing
        $blob = (& git.exe hash-object -- $tmp | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or $blob -ne $modelBlobSHA) {
          throw "RNNoise model integrity mismatch. Refusing to activate voice isolation."
        }
        Move-Item -Force -Path $tmp -Destination $modelPath
      } finally {
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
      }
    }

    # Test the RNN with actual generated audio, not just the -filters list.
    Push-Location $modelDir
    try {
      Run-Checked "Verifying RNNoise model and live FFmpeg audio filter" {
        & $ffmpeg -nostdin -hide_banner -loglevel error -f lavfi -i "sine=frequency=350:sample_rate=48000:duration=0.5" -af "arnndn=m=sh.rnnn:mix=1" -f null -y NUL
      }
    } finally {
      Pop-Location
    }
  }

  $env:MSDS_KWS_VOICE_ISOLATION = $VoiceMode
  $env:MSDS_RNNOISE_MODEL_DIR = $modelDir
  # Never stack old FFT reduction on the neural output.
  $env:MSDS_KWS_AUDIO_DENOISE = "0"
  # Use WebRTC speech segmentation on already-enhanced PCM. No classifier
  # confidence/margin/UNKNOWN threshold is changed.
  $env:MSDS_KWS_WEBRTC_VAD = $(if ($VoiceMode -eq "off") { "0" } else { "1" })
  $env:MSDS_KWS_WEBRTC_MODE = "2"
  Write-Host "[MSDS] Voice isolation=${VoiceMode}: RNNoise at 48 kHz -> 16 kHz original trained DTW." -ForegroundColor Green
  Write-Host "[MSDS] Existing enrollment templates and safety rules unchanged." -ForegroundColor Green
  if ($VoiceMode -ne "off") {
    Write-Host "[MSDS] Noise suppression may cut off quiet syllables or leave some noise. Test the live microphone and English words." -ForegroundColor Yellow
  }

  if (-not $NoLaunch) {
    if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
      throw "Node.js/npm is not installed."
    }
    if (-not (Test-Path (Join-Path $root "node_modules"))) {
      Run-Checked "Installing existing app dependencies" { npm.cmd ci }
    }
    Run-Checked "Starting stable-derived MSDS with voice isolation" { npm.cmd run electron:dev }
  }
} catch {
  Write-Host "[MSDS] Voice isolation setup failed: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "[MSDS] Stable branch remains unchanged; no templates or alerts were overwritten." -ForegroundColor Yellow
  exit 1
} finally {
  Pop-Location
}
