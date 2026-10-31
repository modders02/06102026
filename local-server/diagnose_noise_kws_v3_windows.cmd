@echo off
setlocal
cd /d "%~dp0"
if not exist ".neural-kws-venv\Scripts\python.exe" (
    echo [Noise V3 window audit] Missing isolated Python environment.
    exit /b 1
)
echo [Noise V3 window audit] Frozen-model, read-only segmentation experiment. No training or alerts.
".neural-kws-venv\Scripts\python.exe" "diagnose_noise_kws_v3_windows.py" %*
exit /b %errorlevel%
