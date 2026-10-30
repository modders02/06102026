@echo off
setlocal
cd /d "%~dp0"
rem Keep Python stdout UTF-8 on Windows console hosts.
set "PYTHONIOENCODING=utf-8"
set "PYTHONUTF8=1"
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
echo [MSDS Neural KWS] Checking English BPE dependencies...
".neural-kws-venv\Scripts\python.exe" -c "import sentencepiece, sherpa_onnx; print('[MSDS Neural KWS] English BPE imports passed')"
if errorlevel 1 (
  echo [MSDS Neural KWS] Missing Python package. Review the installer output above.
  exit /b 1
)
echo [MSDS Neural KWS] No sherpa CLI or pypinyin needed for the English-only tokenizer.
".neural-kws-venv\Scripts\python.exe" "prepare_neural_kws.py"
if errorlevel 1 (
  echo [MSDS Neural KWS] Model/keyword preparation failed.
  exit /b 1
)
echo [MSDS Neural KWS] Setup successful. Run local-server\start_neural_kws_shadow.cmd
