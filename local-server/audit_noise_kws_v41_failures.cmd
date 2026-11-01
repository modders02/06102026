@echo off
setlocal
cd /d "%~dp0"
if not exist ".neural-kws-venv\Scripts\python.exe" (
  echo [V4.1 audit] Missing isolated neural Python venv.
  exit /b 1
)
echo [V4.1 audit] ORIGINAL FROZEN CNN, 0.80 threshold, 0.15 margin, research-only.
".neural-kws-venv\Scripts\python.exe" "audit_noise_kws_v41_failures.py" %*
exit /b %errorlevel%
