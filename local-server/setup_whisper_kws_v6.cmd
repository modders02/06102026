@echo off
setlocal
cd /d "%~dp0"
if not exist ".kws-v6-venv\Scripts\python.exe" (
    echo [V6 Setup] Creating separate research-only Python environment...
    py -3 -m venv ".kws-v6-venv"
    if errorlevel 1 (
        echo [V6 Setup] Python launcher unavailable or venv creation failed.
        echo [V6 Setup] Install supported Python 3.9+ or create this separate environment manually.
        exit /b 1
    )
)
echo [V6 Setup] Installing pinned faster-whisper and NumPy in isolated .kws-v6-venv only.
".kws-v6-venv\Scripts\python.exe" -m pip install -r "requirements-whisper-kws-v6.txt"
if errorlevel 1 exit /b 1
echo [V6 Setup] Optional research environment ready. NO pretrained ASR model downloaded.
exit /b 0
