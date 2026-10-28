@echo off
setlocal
cd /d "%~dp0"
echo [MSDS] Neural KWS experiment: DeepFilterNet3 + sherpa-onnx (shadow comparison)
echo [MSDS] First run installs optional Python packages and downloads the English KWS model.
echo [MSDS] Stable DTW recognizer and model templates remain untouched.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0local-server\setup-neural-kws.ps1" %*
if errorlevel 1 (
  echo.
  echo [MSDS] Neural setup or launch failed; no stable source files were modified.
  echo [MSDS] Review errors above, or use your normal npm.cmd run electron:dev startup.
  pause
  exit /b 1
)
endlocal
