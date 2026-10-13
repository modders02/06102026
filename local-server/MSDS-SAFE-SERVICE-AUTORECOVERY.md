# Auto-start and safe port recovery for MSDS camera binaries

## Startup ownership

- `camera_server.py` automatically starts **MediaMTX**, which binds ports
  8554 (RTSP), 8888 (HLS), 8889 (WebRTC), and 9997 (local API).
- The watchdog attempts to restart MediaMTX on a five-second cycle if it exits.
- **FFmpeg** is launched separately for each connected CCTV stream and audio
  worker. **FFprobe** is invoked on demand to inspect RTSP tracks; it is not
  a persistent background service.
- Electron already starts the Python bridge when needed and reuses a live
  existing local bridge detected through `/status`. It must never launch a
  second MediaMTX server directly.

## Automatic conflict handling (without blanket taskkill)

When MediaMTX needs to launch, the bridge checks its TCP ports. A blocking
MediaMTX is terminated **only** when all ownership checks succeed:

1. Its *executable path* matches this MSDS install's resolved MediaMTX binary.
2. Its *single config argument* matches this MSDS install's `mediamtx.yml`.
3. Its original parent process no longer exists (verified orphan).

All other port owners are left alive. This prevents an unrelated RTSP server,
another application, or a still-running MSDS installation from being killed.
For blocked ports, the camera API exposes an actionable `mediamtx_error`.
The watchdog retries at most once per five seconds when a port becomes free.

If another service already listens on API port 5000, a manual second Python
bridge exits *before spawning another MediaMTX instance*. It does not kill
the existing API owner. Electron's supervisor can reuse a healthy existing
bridge, so do not launch a second bridge alongside it.

## Apply the trial branch on Windows

1. Close MSDS and stop any earlier manual `camera_server.py` terminal.
2. From the working copy:

```powershell
git fetch origin
git switch feature/msds-safe-service-autorecovery-20261014
git pull --ff-only origin feature/msds-safe-service-autorecovery-20261014
```

3. Launch one backend instance with the existing experimental speech options:

```powershell
$env:MSDS_KWS_VERIFY_ASR = "1"
$env:MSDS_KWS_HELP_RESCUE = "1"
$env:MSDS_KWS_VERIFY_MODEL = "tiny.en"
& ".\\local-server\\.venv\\Scripts\\python.exe" ".\\local-server\\camera_server.py"
```

4. In a second PowerShell terminal, inspect the streaming state:

```powershell
$s = Invoke-RestMethod "http://127.0.0.1:5000/status"
[pscustomobject]@{
    MediaMTX = $s.mediamtx
    MediaError = $s.mediamtx_error
    Cameras = $s.cameras.Count
}
```

To inspect a **foreign** or still-active port owner without terminating it:

```powershell
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -in @(5000,8554,8888,8889,9997) } |
  Select-Object LocalPort,OwningProcess
```

## Tests

```powershell
& ".\\local-server\\.venv\\Scripts\\python.exe" -m unittest discover -s local-server/tests -p "test_service_recovery.py" -v
& ".\\local-server\\.venv\\Scripts\\python.exe" -m unittest discover -s local-server/tests -p "test_mediamtx_enrollment_recovery.py" -v
```

No user-trained KWS templates are changed; no app needs administrator
privileges to terminate its **own** orphaned MediaMTX process. Other
applications and currently running MSDS bridges remain protected.
