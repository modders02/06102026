@echo off
setlocal
cd /d "%~dp0"
if not exist ".neural-kws-venv\Scripts\python.exe" (
  echo [Noise V4] Missing isolated Python environment. Run setup_neural_kws_windows.cmd first.
  exit /b 1
)
echo [Noise V4] OFFLINE research only: no DTW enrollments, live KWS or alert modifications.
".neural-kws-venv\Scripts\python.exe" "train_noise_kws_v4.py" %*
exit /b %errorlevel%
