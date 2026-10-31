@echo off
setlocal
cd /d "%~dp0"
if not exist ".neural-kws-venv\Scripts\python.exe" (
    echo [V3 Frozen] Missing isolated Python venv. Run local-server\setup_neural_kws_windows.cmd only if needed.
    exit /b 1
)
echo [V3 Frozen] READ-ONLY research analysis, not training or active emergency alerts.
".neural-kws-venv\Scripts\python.exe" "evaluate_noise_kws_v3_frozen.py" %*
exit /b %errorlevel%
