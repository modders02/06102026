# Windows prerequisites for compiling DeepFilterLib's native Rust extension.
# Requires interactive administrator approval for Microsoft's C++ Build Tools.
$ErrorActionPreference = "Stop"

if (-not [Environment]::Is64BitOperatingSystem) {
  throw "The neural KWS experiment requires 64-bit Windows."
}
$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
$vcComponent = "Microsoft.VisualStudio.Component.VC.Tools.x86.x64"

function Get-VisualStudioInstance {
  # Query any installed instance first, not only instances that already have
  # C++ tools. The user's installed Build Tools might be missing that workload.
  if (Test-Path $vswhere) {
    $paths = @(& $vswhere -latest -products "*" -property installationPath 2>$null)
    foreach ($path in $paths) {
      if ($path -and (Test-Path $path.Trim())) { return $path.Trim() }
    }
  }
  # Some installations don't include vswhere on PATH/expected location.
  $candidate = Join-Path $env:ProgramFiles "Microsoft Visual Studio\2022\BuildTools"
  if (Test-Path $candidate) { return $candidate }
  return $null
}

function Find-WorkingMsvc {
  if (-not (Test-Path $vswhere)) { return $null }
  $paths = @(& $vswhere -latest -products "*" -requires $vcComponent -property installationPath 2>$null)
  foreach ($path in $paths) {
    if ($path -and (Test-Path $path.Trim())) { return $path.Trim() }
  }
  return $null
}

function Run-VisualStudioInstaller([string]$Executable, [string]$Arguments, [string]$Operation) {
  # Use the installer from the project working directory, not its own folder.
  # Elevation is interactive: Windows may request the user's approval.
  Write-Host "[MSDS] Visual Studio Installer: $Operation" -ForegroundColor Cyan
  $proc = Start-Process -FilePath $Executable -ArgumentList $Arguments `
    -WorkingDirectory $env:TEMP -Verb RunAs -PassThru -Wait
  if ($proc.ExitCode -eq 3010) {
    throw "Microsoft C++ components installed but a Windows restart is required. Restart and rerun start-neural-kws.cmd."
  }
  if ($proc.ExitCode -ne 0) {
    throw "Visual Studio $Operation returned exit code $($proc.ExitCode). Open Visual Studio Installer > Build Tools 2022 > Modify > Desktop development with C++ (including a Windows SDK), and select Modify. Then rerun start-neural-kws.cmd."
  }
}

function Install-VisualCppTools {
  if (Find-WorkingMsvc) {
    Write-Host "[MSDS] Microsoft C++ compiler components already installed." -ForegroundColor Green
    return
  }
  $existing = Get-VisualStudioInstance
  if ($existing) {
    # NEVER run 'winget install' on an existing VS product. That attempts an
    # upgrade and failed with exit 1 on the user's Build Tools 2022 install.
    $setup = Join-Path (Split-Path $vswhere -Parent) "setup.exe"
    if (-not (Test-Path $setup)) {
      throw "Visual Studio is installed at $existing but the Installer setup.exe is missing. Open Visual Studio Installer and add 'Desktop development with C++' manually."
    }
    Write-Host "[MSDS] Existing Visual Studio found: $existing" -ForegroundColor Yellow
    Write-Host "[MSDS] Adding missing C++ workload to that installation; no upgrade requested." -ForegroundColor Yellow
    $arguments = 'modify --installPath "' + $existing + '" --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --passive --norestart'
    Run-VisualStudioInstaller $setup $arguments "workload modification"
  } else {
    # Fresh installations only: download Microsoft's signed Build Tools 2022
    # bootstrapper. Avoid winget install/upgrade ambiguity.
    Write-Host "[MSDS] No Visual Studio installation found. Downloading official C++ Build Tools." -ForegroundColor Yellow
    $exe = Join-Path $env:TEMP "msds-vs-buildtools.exe"
    Invoke-WebRequest "https://aka.ms/vs/17/release/vs_BuildTools.exe" -OutFile $exe -UseBasicParsing
    $signature = Get-AuthenticodeSignature -FilePath $exe
    if ($signature.Status -ne "Valid" -or
        $signature.SignerCertificate.Subject -notmatch "Microsoft") {
      throw "Microsoft C++ bootstrap signature could not be verified. Refusing to run it."
    }
    $arguments = '--passive --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended'
    Run-VisualStudioInstaller $exe $arguments "new Build Tools installation"
  }
  if (-not (Find-WorkingMsvc)) {
    throw "C++ compiler component not yet detected. Open Visual Studio Installer > Build Tools 2022 > Modify > Desktop development with C++ (including Windows SDK). After completion, rerun."
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
