@echo off
setlocal
cd /d "%~dp0"
if not exist ".neural-kws-venv\Scripts\python.exe" (
  echo [Noise Diagnose] Run local-server\setup_neural_kws_windows.cmd first.
  exit /b 1
)
echo [Noise Diagnose] Read-only model analysis. No retraining or alert changes.
".neural-kws-venv\Scripts\python.exe" "diagnose_noise_augmented_kws.py" %*
exit /b %errorlevel%
