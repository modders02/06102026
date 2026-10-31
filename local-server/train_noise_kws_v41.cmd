@echo off
setlocal
cd /d "%~dp0"
if not exist ".neural-kws-venv\Scripts\python.exe" (
    echo [Noise V4.1] Missing isolated Python environment.
    exit /b 1
)
echo [Noise V4.1] RESEARCH ONLY: uniform context preservation. No active alert/template changes.
".neural-kws-venv\Scripts\python.exe" "train_noise_kws_v41.py" %*
exit /b %errorlevel%
