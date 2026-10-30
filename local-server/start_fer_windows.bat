@echo off
setlocal
cd /d "%~dp0"
if not exist ".fer-venv\Scripts\python.exe" (
  echo [MSDS FER] Missing optional FER environment.
  echo [MSDS FER] Run local-server\setup_fer_windows.bat from the project root first.
  exit /b 1
)
echo [MSDS FER] Starting isolated loopback FER server on 127.0.0.1:5066...
".fer-venv\Scripts\python.exe" "fer_emotion_service.py"
exit /b %errorlevel%
