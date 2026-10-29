# Resumable official CUDA 12.4 PyTorch 2.5.1 wheel for Windows Python 3.12.
# Strict CUDA mode: never install a CPU fallback.
param(
  [Parameter(Mandatory = $true)][string]$PythonExe,
  [string]$CacheDirectory = (Join-Path $PSScriptRoot ".gpu-wheel-cache")
)
$ErrorActionPreference = "Stop"
if (-not (Test-Path -LiteralPath $PythonExe)) { throw "GPU Python interpreter not found: $PythonExe" }
if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) { throw "Windows curl.exe is required for resumable CUDA downloads." }
New-Item -ItemType Directory -Force -Path $CacheDirectory | Out-Null

# Exact official download URL observed from pip for CPython 3.12 x64.
$wheelName = "torch-2.5.1+cu124-cp312-cp312-win_amd64.whl"
$wheelUrl = "https://download-r2.pytorch.org/whl/cu124/torch-2.5.1%2Bcu124-cp312-cp312-win_amd64.whl"
$wheelPath = Join-Path $CacheDirectory $wheelName
$partialPath = "$wheelPath.part"

function Test-WheelZip([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $false }
  # Verify CRC for every entry, not just the archive's ZIP signature.
  & $PythonExe -c "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); bad=z.testzip(); z.close(); assert bad is None, 'wheel CRC check failed'" $Path
  return ($LASTEXITCODE -eq 0)
}

if (Test-Path -LiteralPath $wheelPath) {
  Write-Host "[MSDS CUDA] Validating cached CUDA wheel..." -ForegroundColor Cyan
  if (-not (Test-WheelZip $wheelPath)) {
    Write-Warning "Removing corrupt completed GPU wheel; preserved incomplete downloads are separate."
    Remove-Item -LiteralPath $wheelPath -Force
  }
}

if (-not (Test-Path -LiteralPath $wheelPath)) {
  if (Test-Path -LiteralPath $partialPath) {
    $downloaded = [math]::Round((Get-Item -LiteralPath $partialPath).Length / 1MB, 1)
    Write-Host "[MSDS CUDA] Resuming $downloaded MiB of the cached GPU wheel..." -ForegroundColor Yellow
  } else {
    Write-Host "[MSDS CUDA] Starting resumable official 2.5 GB wheel download." -ForegroundColor Cyan
    Write-Host "[MSDS CUDA] The previous pip temporary download cannot be recovered into this persistent cache." -ForegroundColor Yellow
  }
  # --continue-at - resumes the existing .part file using HTTP Range.
  # Retain the .part file when retry/timeouts are exhausted.
  & curl.exe --fail --location --continue-at - --retry 20 --retry-all-errors --retry-delay 10 --connect-timeout 45 --speed-time 120 --speed-limit 1024 --output $partialPath $wheelUrl
  if ($LASTEXITCODE -ne 0) {
    $bytes = if (Test-Path -LiteralPath $partialPath) { [math]::Round((Get-Item -LiteralPath $partialPath).Length / 1MB, 1) } else { 0 }
    throw "CUDA download interrupted at $bytes MiB. Partial file preserved; rerun the launcher to resume."
  }
  Write-Host "[MSDS CUDA] Validating wheel archive CRCs..." -ForegroundColor Cyan
  if (-not (Test-WheelZip $partialPath)) {
    throw "CUDA wheel archive failed CRC validation. Check network/cache: $partialPath"
  }
  Move-Item -LiteralPath $partialPath -Destination $wheelPath -Force
}
Write-Host "[MSDS CUDA] Installing cached CUDA torch and matched torchaudio..." -ForegroundColor Green
& $PythonExe -m pip install --timeout 900 --retries 15 --index-url "https://download.pytorch.org/whl/cu124" $wheelPath "torchaudio==2.5.1"
if ($LASTEXITCODE -ne 0) {
  throw "CUDA installation failed; cached verified torch wheel is preserved at $wheelPath."
}
Write-Host "[MSDS CUDA] CUDA torch+torchaudio installation completed." -ForegroundColor Green
