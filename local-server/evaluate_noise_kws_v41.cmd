@echo off
setlocal
cd /d "%~dp0"
if not exist ".neural-kws-venv\Scripts\python.exe" (
    echo [Noise V4.1 evaluate] Missing isolated Python environment.
    exit /b 1
)
echo [Noise V4.1 evaluate] Frozen context-preserving model, fresh local WAVs only.
echo [Noise V4.1 evaluate] No retraining, enrolled templates or operational alerts.
".neural-kws-venv\Scripts\python.exe" "evaluate_noise_kws_v41.py" %*
exit /b %errorlevel%
