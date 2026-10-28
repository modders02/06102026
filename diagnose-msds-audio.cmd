@echo off
setlocal
cd /d "%~dp0"
echo [MSDS] Checking Camera 1 microphone and keyword engine. Read-only.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0local-server\diagnose-msds-audio.ps1" %*
if errorlevel 1 (
  echo [MSDS] Diagnostic could not finish. Check that the local camera service is running.
  exit /b 1
)
endlocal
