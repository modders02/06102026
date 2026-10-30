@echo off
setlocal
cd /d "%~dp0"
if not exist ".neural-kws-venv\Scripts\python.exe" (
  echo [MSDS Neural KWS] Run local-server\setup_neural_kws_windows.cmd first.
  exit /b 1
)
echo [MSDS Neural KWS] SHADOW-ONLY live CCTV listening: no alerts, no KWS template changes.
echo [MSDS Neural KWS] Exit with Ctrl+C. Default camera: slot-1.
".neural-kws-venv\Scripts\python.exe" "neural_kws_trial.py" --camera slot-1 %*
exit /b %errorlevel%
