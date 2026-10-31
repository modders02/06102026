@echo off
setlocal
cd /d "%~dp0"
if not exist ".neural-kws-venv\Scripts\python.exe" (
    echo [Noise V3 diagnose] Missing isolated Python environment.
    exit /b 1
)
echo [Noise V3 diagnose] Read-only saved-model analysis. No retraining or alert changes.
".neural-kws-venv\Scripts\python.exe" "diagnose_noise_kws_v3.py" %*
exit /b %errorlevel%
