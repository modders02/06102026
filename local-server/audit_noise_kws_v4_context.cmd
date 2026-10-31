@echo off
setlocal
cd /d "%~dp0"
if not exist ".neural-kws-venv\Scripts\python.exe" (
    echo [Context audit] Missing isolated Python environment.
    exit /b 1
)
echo [Context audit] Listen to the nine previously incomplete V4 crops with +0.55s context.
echo [Context audit] No retraining, no saved WAVs, no active MSDS alert changes.
".neural-kws-venv\Scripts\python.exe" "audit_noise_kws_v4_context.py" %*
exit /b %errorlevel%
