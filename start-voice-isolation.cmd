@echo off
setlocal
cd /d "%~dp0"
echo [MSDS] Stable-derived voice isolation -- RNNoise neural speech filter
echo [MSDS] No changes to stable_branch_271026 or enrolled DTW templates.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0local-server\setup-voice-isolation.ps1" %*
if errorlevel 1 (
  echo [MSDS] Setup or launch failed. Original stable startup is still available.
  pause
  exit /b 1
)
endlocal
