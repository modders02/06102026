@echo off
setlocal
cd /d "%~dp0"
if not exist ".neural-kws-venv\Scripts\python.exe" (
  echo [Noise V4 evaluate] Missing isolated Python environment.
  exit /b 1
)
echo [Noise V4 evaluate] FROZEN research model, separate fresh WAV directory. No training or alerts.
".neural-kws-venv\Scripts\python.exe" "evaluate_noise_kws_v4.py" %*
exit /b %errorlevel%
