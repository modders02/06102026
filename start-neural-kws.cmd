@echo off
setlocal
cd /d "%~dp0"
echo [MSDS] Reliable CCTV keyword listening: original trained DTW engine.
echo [MSDS] Default: standard noise filter, normal hearing, neural off.
echo [MSDS] Optional: -Mode shadow enables DeepFilterNet3 + sherpa-onnx comparison.
echo [MSDS] Existing enrolled templates and stable branch remain untouched.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0local-server\setup-neural-kws.ps1" %*
if errorlevel 1 (
  echo.
  echo [MSDS] Neural setup or launch failed; no stable source files were modified.
  echo [MSDS] Review errors above, or use your normal npm.cmd run electron:dev startup.
  pause
  exit /b 1
)
endlocal
