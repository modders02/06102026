@echo off
setlocal
cd /d "%~dp0"
if not exist ".neural-kws-venv\Scripts\python.exe" (
  echo [Noise Capture] Run local-server\setup_neural_kws_windows.cmd first.
  exit /b 1
)
echo [Noise Capture] Consent required. Private recordings under neural-kws-data.
".neural-kws-venv\Scripts\python.exe" "capture_noise_kws_wavs.py" %*
exit /b %errorlevel%
