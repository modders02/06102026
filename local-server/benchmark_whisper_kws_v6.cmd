@echo off
setlocal
cd /d "%~dp0"
if not exist ".kws-v6-venv\Scripts\python.exe" (
    echo [V6 Whisper ASR] Missing isolated environment. Run local-server\setup_whisper_kws_v6.cmd first.
    exit /b 1
)
echo [V6 Whisper ASR] OFFLINE RESEARCH ONLY. No CCTV access, training or operational alert changes.
".kws-v6-venv\Scripts\python.exe" "benchmark_whisper_kws_v6.py" %*
exit /b %errorlevel%
