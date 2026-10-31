@echo off
setlocal
cd /d "%~dp0"
if not exist ".neural-kws-venv\Scripts\python.exe" (
    echo [Crop review] Missing isolated Python environment.
    exit /b 1
)
echo [Crop review] LOCAL manual listening: original vs V4 crop. No training/alerts.
".neural-kws-venv\Scripts\python.exe" "audit_noise_kws_v4_crops.py" %*
exit /b %errorlevel%
