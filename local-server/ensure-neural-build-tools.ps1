# Windows prerequisites for compiling DeepFilterLib's native Rust extension.
# Requires interactive administrator approval for Microsoft's C++ Build Tools.
$ErrorActionPreference = "Stop"

if (-not [Environment]::Is64BitOperatingSystem) {
  throw "The neural KWS experiment requires 64-bit Windows."
}
$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
$vcComponent = "Microsoft.VisualStudio.Component.VC.Tools.x86.x64"

function Find-WorkingMsvc {
  if (-not (Test-Path $vswhere)) { return $null }
  $install = & $vswhere -latest -products "*" -requires $vcComponent -property installationPath 2>$null
  if ($LASTEXITCODE -eq 0 -and $install) { return ($install | Select-Object -First 1) }
  return $null
}

function Install-VisualCppTools {
  if (Find-WorkingMsvc) {
    Write-Host "[MSDS] Microsoft C++ compilation tools found." -ForegroundColor Green
    return
  }
  Write-Host "[MSDS] DeepFilterLib needs the Microsoft C++ compiler and Windows SDK." -ForegroundColor Yellow
  Write-Host "[MSDS] Installing official C++ Build Tools (large download; UAC approval may be required)." -ForegroundColor Yellow
  $installed = $false
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if ($winget) {
    & $winget.Source install --id Microsoft.VisualStudio.2022.BuildTools --exact `
      --source winget --accept-source-agreements --accept-package-agreements `
      --override "--passive --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
    $installed = ($LASTEXITCODE -eq 0)
  }
  if (-not $installed) {
    $exe = Join-Path $env:TEMP "msds-vs-buildtools.exe"
    Invoke-WebRequest "https://aka.ms/vs/17/release/vs_BuildTools.exe" -OutFile $exe -UseBasicParsing
    $signature = Get-AuthenticodeSignature -FilePath $exe
    if ($signature.Status -ne "Valid" -or
        $signature.SignerCertificate.Subject -notmatch "Microsoft") {
      throw "Microsoft C++ bootstrap signature could not be verified. Refusing to run it."
    }
    $args = @(
      "--passive", "--wait", "--norestart",
      "--add", "Microsoft.VisualStudio.Workload.VCTools", "--includeRecommended"
    )
    $process = Start-Process -FilePath $exe -ArgumentList $args -Verb RunAs -Wait -PassThru
    if ($process.ExitCode -notin @(0, 3010)) {
      throw "Microsoft Visual Studio Build Tools exited with code $($process.ExitCode)."
    }
    if ($process.ExitCode -eq 3010) {
      throw "Microsoft C++ tools installed; please restart Windows and rerun start-neural-kws.cmd."
    }
  }
  if (-not (Find-WorkingMsvc)) {
    throw "C++ x64 tools not detected. Use Visual Studio Installer > Desktop development with C++ (including Windows SDK), then rerun."
  }
  Write-Host "[MSDS] Microsoft C++ compiler confirmed." -ForegroundColor Green
}

function Install-Rust {
  $cargoPath = Join-Path $env:USERPROFILE ".cargo\bin"
  if (Test-Path $cargoPath) { $env:Path = "$cargoPath;$env:Path" }
  if (-not (Get-Command cargo.exe -ErrorAction SilentlyContinue)) {
    Write-Host "[MSDS] Installing official 64-bit Rust/Cargo MSVC toolchain." -ForegroundColor Yellow
    $rustup = Join-Path $env:TEMP "msds-rustup-init.exe"
    Invoke-WebRequest `
      "https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe" `
      -OutFile $rustup -UseBasicParsing
    # rustup distributions are not necessarily Authenticode signed.
    # Only download from the official Rust distribution over HTTPS.
    & $rustup -y --profile minimal --default-toolchain stable `
      --default-host x86_64-pc-windows-msvc --no-modify-path
    if ($LASTEXITCODE -ne 0) { throw "Official Rustup installation failed." }
    $env:Path = "$cargoPath;$env:Path"
  }
  if (-not (Get-Command cargo.exe -ErrorAction SilentlyContinue) -or
      -not (Get-Command rustc.exe -ErrorAction SilentlyContinue)) {
    throw "Cargo/rustc unavailable. Restart PowerShell and rerun start-neural-kws.cmd."
  }
  & cargo.exe --version
  if ($LASTEXITCODE -ne 0) { throw "Cargo failed its version check." }
  & rustc.exe --version
  if ($LASTEXITCODE -ne 0) { throw "Rust compiler failed its version check." }
}

Install-VisualCppTools
Install-Rust
Write-Host "[MSDS] Native Rust/MSVC build prerequisites ready." -ForegroundColor Green
