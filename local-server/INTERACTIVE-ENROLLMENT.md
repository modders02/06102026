# Original-style interactive CCTV keyword enrollment

This is the **old live-enrollment workflow**: **press Enter, say one word,
wait for SAVED, press Enter again**. The command uses the existing MSDS
`POST /cameras/{camera}/kws-enroll/{word}` endpoint directly. It **does not**
use the offline WAV collector, the household speech trainer or the laptop mic.

> This changes your **active** recognizer as soon as each sample is captured.
> It does not record a playable WAV or let you accept/reject the captured
> segment. Noise mistakenly captured as speech can contaminate the model.
> Do **not** expect 100% accuracy; validate with separate real-world tests.

## Requirements

Start MSDS with MediaMTX and an audio-enabled CCTV camera. The local bridge
should be running at `127.0.0.1:5000`, and `/status` should show the camera
ID (`slot-1` by default) with `ffmpeg=true`,
`audio.thread_running=true` and `audio.connected=true`.

If MediaMTX is missing, stop the old camera-server terminal, then from the
repository root use an existing Python interpreter:

```powershell
$py = "D:\Users\nazar\Documents\ongoin\remix-of-sentry-vision-main\local-server\.venv\Scripts\python.exe"
& $py ".\local-server\fetch_binaries.py"
```

Verify `Test-Path .\local-server\bin\mediamtx.exe` returns `True`
before restarting the camera bridge. Start the camera, then confirm its
audio status. Do not run duplicate camera bridges on the same port.

## Diagnose a MediaMTX startup failure

The Python server now checks whether MediaMTX stays alive. If it crashes
because of an invalid YAML option or a conflicting port, both the console and
`GET /status` show the actual startup error (with RTSP credentials redacted).
The repository contains a small compatible `mediamtx.yml` instead of an
outdated generated vendor config.

In PowerShell, start the local bridge, then in another terminal run:

```powershell
$st = Invoke-RestMethod "http://127.0.0.1:5000/status"
$st | Select-Object mediamtx, mediamtx_error, available_camera_ids
```

If `mediamtx` is `False`, read `mediamtx_error`. A bind error for `:8554`,
`:8888`, `:8889` or `:8189` generally means another program owns the port;
stop the conflicting instance instead of launching duplicate camera bridges.

If `available_camera_ids` is empty, open MSDS and press **Connect** on the
RTSP camera. The camera list lives in the app and is registered with the
Python server through `POST /cameras/sync` after a bridge restart; simply
restarting `camera_server.py` does not restore it. Avoid pasting CCTV RTSP
credentials into shared terminal logs.

Enrollment now refuses to arm if MediaMTX is down, the camera is absent,
video is offline, or CCTV audio has not delivered PCM frames. Fix the
reported problem instead of recording silent training templates.

## One terminal, repeated speech recordings

From your local `06102026-kws` checkout of
`feature/msds-next-updates-20261013`:

```powershell
cd "D:\Users\nazar\Documents\ongoin\06102026-kws"
git pull --ff-only origin feature/msds-next-updates-20261013
$py = "D:\Users\nazar\Documents\ongoin\remix-of-sentry-vision-main\local-server\.venv\Scripts\python.exe"
& $py ".\local-server\enroll_english_kws.py" --camera slot-1 --keyword help --samples 5
```

At the **first** Enter, the tool arms the original CCTV KWS enrolment. When
it says `LISTENING`, say **Help** once and pause. It polls the backend until
it says `SAVED: HELP sample 1/10` (or reports an error). Press Enter a
second time only when ready to record a second real utterance. A `q`
finishes early. `Ctrl+C` cancels a pending enrollment.

The tool backs up the **actual running MSDS template directory** from
`/kws/status.data_dir` to `local-server/kws-backups/*.zip` before it
allows any enrollment. A backup containing zero templates means none were
present in that local runtime directory. The script refuses to enroll above
the model limits (10 positive / 40 unknown) to avoid the original engine's
oldest-template replacement behavior.

Record other words in a separate terminal session:

```powershell
& $py ".\local-server\enroll_english_kws.py" --camera slot-1 --keyword fire --samples 5
& $py ".\local-server\enroll_english_kws.py" --camera slot-1 --keyword emergency --samples 5
& $py ".\local-server\enroll_english_kws.py" --camera slot-1 --keyword danger --samples 5
& $py ".\local-server\enroll_english_kws.py" --camera slot-1 --keyword intruder --samples 5
& $py ".\local-server\enroll_english_kws.py" --camera slot-1 --keyword police --samples 5
& $py ".\local-server\enroll_english_kws.py" --camera slot-1 --keyword ambulance --samples 5
& $py ".\local-server\enroll_english_kws.py" --camera slot-1 --keyword stop --samples 5
& $py ".\local-server\enroll_english_kws.py" --camera slot-1 --keyword unknown --samples 10
```

For `unknown`, speak genuinely different *non-emergency* words/phrases.
A template count becoming ready is **not** proof of detection accuracy.

## Safety and quality checks

- Before any staged emergency phrase, disable external alert notifications
  and automated dispatch. Conduct enrollment only with authorized speakers.
- Do not allow bystanders to be recorded or introduce noisy unrelated speech
  between arming and saying the labeled word.
- Enroll one word per take and pause until the script confirms it was saved.
- If a bad segment is accidentally enrolled, **stop** and restore a backed-up
  template set or use deliberate manual inspection; the old endpoint does not
  allow deleting an individual bad template.
- Before re-enabling alerts, use `GET /kws/evaluate` for cross-keyword
  calibration and carry out separate unseen real CCTV tests with normal indoor
  noise. This endpoint audits templates, not an independent held-out dataset.
