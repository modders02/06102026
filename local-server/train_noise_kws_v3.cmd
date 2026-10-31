@echo off
setlocal
cd /d "%~dp0"
if not exist ".neural-kws-venv\Scripts\python.exe" (
    echo [Noise V3] Run local-server\setup_neural_kws_windows.cmd first.
    exit /b 1
)
echo [Noise V3] Experimental grouped validation training only. No active template changes.
".neural-kws-venv\Scripts\python.exe" "train_noise_kws_v3.py" %*
exit /b %errorlevel%
