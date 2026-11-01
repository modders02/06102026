@echo off
setlocal
cd /d "%~dp0"
if not exist ".neural-kws-venv\Scripts\python.exe" (
  echo [V4.1 listen] Isolated neural-kws Python environment missing.
  exit /b 1
)
echo [V4.1 listen] Private original-vs-context listening only; no alerts or model retraining.
".neural-kws-venv\Scripts\python.exe" "audit_noise_kws_v41_playback.py" %*
exit /b %errorlevel%
