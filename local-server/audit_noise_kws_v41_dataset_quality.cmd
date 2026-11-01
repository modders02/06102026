@echo off
setlocal
cd /d "%~dp0"
if not exist ".neural-kws-venv\Scripts\python.exe" (
  echo [V4.1 quality] Missing isolated neural-kws Python venv.
  exit /b 1
)
echo [V4.1 quality] Original frozen CNN + human review; metadata only, no model or WAV changes.
".neural-kws-venv\Scripts\python.exe" "audit_noise_kws_v41_dataset_quality.py" %*
exit /b %errorlevel%
