# MSDS Windows Electron: automatic FFmpeg, MediaMTX, and HELP 90 KWS

This implementation is based on `restore/pre-emotion-training-20261014`.
No FER2013 model or experimental emotion-training changes are included.

## What starts automatically

Opening the installed **MSDS System.exe** starts the dashboard and its
Electron-managed Python camera server. The Python server manages FFmpeg,
FFprobe, MediaMTX and custom KWS as cameras are activated.

When Electron launches the backend, it supplies these defaults **without
requiring manual PowerShell setup**:

```powershell
$env:MSDS_KWS_VERIFY_ASR = "0"
$env:MSDS_KWS_HELP_RESCUE = "0"
$env:MSDS_KWS_SHORT_HELP_ASR = "0"
$env:MSDS_KWS_HELP_90_FAST_ACCEPT = "1"
```

The Electron process sets these variables for its Python **child process**
only; it does not permanently change Windows environment settings.
Explicit process environment overrides remain supported for controlled
diagnostics.

The KWS HELP >=90 feature still requires HELP to be top-ranked, sufficient
template/UNKNOWN separation, valid audio duration, and an eligible KWS
decision. **HELP KWS acceptance is not camera alert acceptance**: the
existing facial/visual corroboration and alert validation gates remain.

## Development: one command

From the repository root, with `npm install` already completed:

```powershell
npm.cmd run electron:dev
```

Electron opens Vite and automatically prepares/launches the Python bridge.
You do **not** need to run `start_server.bat` or set the KWS variables
manually.

## Create the standalone Windows installer

Run these on your Windows PC, from the repo root:

```powershell
npm.cmd install
npm.cmd run electron:test
npm.cmd run electron:build
```

`electron:build` now downloads the **three required native executables**
(`ffmpeg.exe`, `ffprobe.exe`, `mediamtx.exe`) into
`local-server/bin` **before** Electron Builder starts, unless already
present. It verifies that none are empty/invalid-sized files and aborts
the installer build if tools are unavailable. Electron Builder includes
`local-server/bin` as external packaged resources.

Installer path:

```text
release/MSDS-System-Setup.exe
```

Alternatively, the GitHub Actions *Electron Windows build* workflow creates
the Windows installer artifact on the feature branch.

### Installation prerequisites

The installation is not fully offline or Python-free:

- Windows installer includes camera media binaries, so normally no binary
  download is needed on first launch.
- Destination PC **still needs Python 3.10+** accessible as `py` or
  `python` (or `MSDS_PYTHON_EXE`). It does not bundle an embedded Python
  interpreter.
- On first launch, Electron creates a Python virtual environment in
  `%APPDATA%/msds-system/camera-runtime` (the exact parent depends
  on Electron's `userData` path) and installs its requirements. Internet
  access is normally needed for this initial Python dependency setup.
- The previously enrolled KWS templates must still be available to the
  Python runtime; binaries alone do not imply enrollment/model readiness.
- The first launch can take several minutes. Subsequent launches reuse
  the installed dependencies and media binaries.

If the Python backend is **already running manually on port 5000**, Electron
reuses it rather than creating a conflicting second server. That **existing
process retains its own KWS environment** and will *not* receive these new
defaults. Stop the old backend before launching the app to use the
automatic settings:

```powershell
Get-NetTCPConnection -LocalPort 5000 -State Listen -ErrorAction SilentlyContinue
```

Do not kill an unrelated process without identifying it.

## Verify backend settings

After Electron reports the backend ready (and the camera is connected):

```powershell
$k = ((Invoke-RestMethod "http://127.0.0.1:5000/status").cameras |
      Where-Object id -eq "slot-1").audio.custom_kws

$k | Format-List verification_enabled,help_rescue_enabled,help_90_fast_accept_enabled,last_decision,last_keyword
```

Expected configuration for a managed backend:

```text
verification_enabled          : False
help_rescue_enabled           : False
help_90_fast_accept_enabled  : True
```

The camera may not expose keyword status until it is connected.
These settings do not guarantee every utterance of HELP gets accepted.

## Rollback

Switch to `restore/pre-emotion-training-20261014` to return to the
unmodified launcher. The experiment branches and Supabase data remain
unchanged.
