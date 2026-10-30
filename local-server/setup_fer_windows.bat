@echo off
setlocal
cd /d "%~dp0"
echo [MSDS FER] Installing optional facial expression model into its OWN venv.
echo [MSDS FER] This will NOT modify .venv, .gpu-venv, or KWS training templates.
if not exist ".fer-venv\Scripts\python.exe" (
  py -3.12 -m venv ".fer-venv"
  if errorlevel 1 (
    echo [MSDS FER] Python 3.12 unavailable or venv creation failed.
    exit /b 1
  )
)
".fer-venv\Scripts\python.exe" -m pip install -r "requirements-fer.txt"
if errorlevel 1 (
  echo [MSDS FER] Dependency installation failed.
  exit /b 1
)
echo [MSDS FER] Checking FER 25.10.3 import...
".fer-venv\Scripts\python.exe" -c "from fer.fer import FER; print('[MSDS FER] Import check passed')"
if errorlevel 1 (
  echo [MSDS FER] Import verification failed; check the Python error above.
  exit /b 1
)
echo [MSDS FER] Dependencies installed. Run local-server\start_fer_windows.bat
