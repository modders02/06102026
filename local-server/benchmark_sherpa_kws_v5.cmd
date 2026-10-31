@echo off
setlocal
cd /d "%~dp0"
if not exist ".neural-kws-venv\Scripts\python.exe" (
    echo [V5 Pretrained] Python venv missing. Run local-server\setup_neural_kws_windows.cmd first.
    exit /b 1
)
echo [V5 Pretrained] OFFLINE SHERPA KWS BENCHMARK. No training, live CCTV or alert changes.
".neural-kws-venv\Scripts\python.exe" "benchmark_sherpa_kws_v5.py" %*
exit /b %errorlevel%
