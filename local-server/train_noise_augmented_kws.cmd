@echo off
setlocal
cd /d "%~dp0"
if not exist ".neural-kws-venv\Scripts\python.exe" (
  echo [Noise Train] Run local-server\setup_neural_kws_windows.cmd first.
  exit /b 1
)
echo [Noise Train] Training separate advisory candidate only. No template installation.
".neural-kws-venv\Scripts\python.exe" "train_noise_augmented_kws.py" %*
exit /b %errorlevel%
