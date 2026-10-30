# FER facial-expression experiment

Branch: experiment/fer-emotion-stability-20261030
Base: design/premium-landing-page-20261029

This experiment integrates the Python FER library as an **optional, local**
seven-class expression classifier. It does not modify the enrolled KWS data
or replace the proven safety gate.

## Windows setup

Open two terminals in the MSDS project folder:

Terminal 1, once (installs into a separate venv):

    .\local-server\setup_fer_windows.bat

Terminal 1, each session (the program remains running):

    .\local-server\start_fer_windows.bat

Verify from a different PowerShell session:

    Invoke-RestMethod "http://127.0.0.1:5066/health"

Expected: ok=true, engine=fer, mode=display-only, ready=true.

Terminal 2, start the app:

    npm.cmd run electron:dev

Keep the FER terminal open while using the app. Closing it restores the
face-api fallback. FER will attempt to reconnect after backoff.

## Design and safety

- FER runs in local-server/.fer-venv, separate from .venv and .gpu-venv,
  to avoid conflicts with Camera Server / NumPy KWS / NVIDIA PyTorch.
- The frontend uses its existing Face-api face detection to isolate the
  largest face, sends a temporary JPEG crop to an HTTP server bound to
  127.0.0.1:5066, and never saves the image.
- FER expressions are for **display and Event History only**. They never
  authorize emergency alerts or influence KWS enrollment.
- Event History labels require three consecutive confident, non-ambiguous
  observations from the same classifier. Failed or ambiguous predictions
  do not generate new history entries.
- The original Face-api-based speech+face fusion requires two consecutive
  fresh frames before the face can count as distress evidence.
- Surprised no longer counts as Frightened in alert validation.
- Displayed emotion is a fallible facial-expression estimate and does not
  diagnose a person's actual mood or mental state.

## FER library and performance

This experiment pins FER 25.10.3, which uses OpenCV face detection and
TensorFlow-model components. Installation can download large dependencies;
CPU inference timing depends on the PC. This separate Python environment
is NOT automatically GPU-accelerated by the existing CUDA KWS setup.

This is an evaluation, not a proven accuracy improvement. Compare
classification accuracy, confusion between Surprised/Frightened/Sad,
CPU overhead, FPS, and event-history false positives using labeled
recordings before merging with a stable safety-critical system.

## Validation

    npm.cmd run build
    npm.cmd test -- --run src/test/ferEmotion.test.ts src/test/emotionStability.test.ts src/test/multimodalDistress.test.ts
    & ".\local-server\.venv\Scripts\python.exe" -m unittest discover -s ".\local-server\tests" -p "test_fer_emotion_service.py" -v

For a real-camera evaluation, temporarily disable external emergency
notifications and do not use the experimental classifier as a sole
safety monitor.
