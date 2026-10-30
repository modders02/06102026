@echo off
setlocal
cd /d "%~dp0"
echo [MSDS Neural KWS] Optional SHADOW experiment. Nothing changes in active DTW enrollments.
if not exist ".neural-kws-venv\Scripts\python.exe" (
  py -3.12 -m venv ".neural-kws-venv"
  if errorlevel 1 (
    echo [MSDS Neural KWS] Python 3.12 could not create the isolated environment.
    exit /b 1
  )
)
".neural-kws-venv\Scripts\python.exe" -m pip install -r "requirements-neural-kws.txt"
if errorlevel 1 (
  echo [MSDS Neural KWS] Package installation failed.
  exit /b 1
)
echo [MSDS Neural KWS] Checking sherpa-onnx-cli keyword tokenization command...
".neural-kws-venv\Scripts\sherpa-onnx-cli.exe" text2token --help >nul
if errorlevel 1 (
  echo [MSDS Neural KWS] sherpa-onnx-cli is missing a runtime dependency. Review the error above.
  exit /b 1
)
".neural-kws-venv\Scripts\python.exe" "prepare_neural_kws.py"
if errorlevel 1 (
  echo [MSDS Neural KWS] Model/keyword preparation failed.
  exit /b 1
)
echo [MSDS Neural KWS] Setup successful. Run local-server\start_neural_kws_shadow.cmd
