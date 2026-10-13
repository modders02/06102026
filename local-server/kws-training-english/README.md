# MSDS — controlled CCTV English emergency-word training

Use **real consenting speakers** and the connected camera's audio track, not
the laptop microphone. Training audio is sensitive: WAV, holdout recordings,
model templates, and ZIP backups are **ignored by Git**. Keep them on the
authorized MSDS training computer; do not paste RTSP credentials into commands.

## Scope

Trained English labels: `help`, `fire`, `emergency`, `danger`, `intruder`,
`police`, `ambulance`, `stop`. Also train `unknown` using **different
non-emergency words and ordinary speech**.

| Split | Eight positive classes | UNKNOWN |
| --- | --- | --- |
| Training | at least 5 distinct utterances per word | at least 10 |
| Held-out evaluation | at least 3 unseen utterances per word | at least 10 |

In total, **84 consented speech recordings** is the minimum for the
recommended training-and-heldout workflow. Prefer more from multiple
speakers/distances/noise conditions. Keep held-out speech separate: never
copy held-out files to the training split. Capture *clean and realistic-noise*
variants; include separate background-only recordings in later false-alarm tests,
not as positive class speech.

## 1. Back up the original trained templates FIRST

From the repository root in Windows PowerShell:

```powershell
git switch feature/msds-next-updates-20261013
git pull --ff-only origin feature/msds-next-updates-20261013
.\local-server\.venv\Scripts\python.exe local-server\train_english_kws.py --backup-only
```

The command prints a `local-server/kws-backups/msds-kws-....zip` path.
Confirm that file exists. The ZIP is never uploaded to GitHub and includes
the current `.npy` templates (if any). The active template directory respects
`MSD_KWS_DATA_DIR`. If zero templates exist the archive reports zero; there
is no previously trained model to restore on this machine.

## 2. Connect and verify the CCTV microphone

Start the MSDS Electron app/local bridge, connect CCTV in Camera 1, and
enable the camera microphone in the camera's own settings. On PowerShell:

```powershell
$st = Invoke-RestMethod http://127.0.0.1:5000/status
$st.cameras | Select-Object id, name, ffmpeg, path
$st.cameras | ForEach-Object { $_.audio | Select-Object has_audio_track, connected, chunks_received }
```

Keep the camera connected while collecting, so the recorder can use its
**local MediaMTX restream** `rtsp://127.0.0.1:8554/{camera path}`.
This avoids opening another session against the original camera and avoids
typing credentials into PowerShell. If the stream lacks an audio track,
capture cannot work; correct RTSP audio/microphone settings first.

**Training safety**: Do this in a controlled session with permissions and
consent. Pause emergency response workflows and disable external emergency
notifications/automations before saying staged emergency words. A connected
camera may still recognize words in its regular background loop. Never
stage events with real emergency dispatch recipients enabled; restore normal
monitoring after the recording session.

## 3. Collect and inspect each word

The collector waits until actual PCM is flowing, prints `AUDIO READY`,
then you say the word **once** and pause. It runs the production
speech-segmentation logic and rejects no speech, too short, quiet, clipped or
overlong speech. Each accepted WAV is 16 kHz mono PCM.

```powershell
$py = ".\local-server\.venv\Scripts\python.exe"
& $py local-server\collect_english_kws.py --camera slot-1 --keyword help --count 5
& $py local-server\collect_english_kws.py --camera slot-1 --keyword fire --count 5
& $py local-server\collect_english_kws.py --camera slot-1 --keyword emergency --count 5
& $py local-server\collect_english_kws.py --camera slot-1 --keyword danger --count 5
& $py local-server\collect_english_kws.py --camera slot-1 --keyword intruder --count 5
& $py local-server\collect_english_kws.py --camera slot-1 --keyword police --count 5
& $py local-server\collect_english_kws.py --camera slot-1 --keyword ambulance --count 5
& $py local-server\collect_english_kws.py --camera slot-1 --keyword stop --count 5
& $py local-server\collect_english_kws.py --camera slot-1 --keyword unknown --count 10
```

Windows plays back the captured utterance. Press `y` **only if the audio
contains exactly the stated label**; otherwise press Enter to discard and
retry. VAD can locate speech but cannot establish the word's linguistic
identity without a trained recognizer. For `unknown`, the recorded speech
should contain **no** training keyword, and should vary across examples.

## 4. Collect separate unseen holdout recordings

Repeat on different speakers/positions/noise conditions with `--set holdout`:

```powershell
foreach ($word in @("help","fire","emergency","danger","intruder","police","ambulance","stop")) {
    & $py local-server\collect_english_kws.py --camera slot-1 --keyword $word --count 3 --set holdout
}
& $py local-server\collect_english_kws.py --camera slot-1 --keyword unknown --count 10 --set holdout
```

Private data locations:
- `local-server/kws-training-english/<keyword>/*.wav` — candidate templates
- `local-server/kws-holdout-english/<keyword>/*.wav` — unseen validation
- `local-server/kws-backups/*.zip` — active-model backups

## 5. Preview without overwriting the currently trained model

Close the actual emergency monitoring for the preview as well.

```powershell
& $py local-server\train_english_kws.py
```

This produces an **isolated temporary candidate**, checks all label counts,
per-keyword leave-one-out calibration, and the held-out samples. It
prints `eligible_to_apply`. It **never changes** the original active
`kws-data-v2` folder.

If results are weak, add independent *real* examples and retry the preview;
do not adjust thresholds just to force a passing report.

## 6. Apply only when calibration + unseen evaluation pass

Close **MSDS Electron and its Python camera bridge** before this step.
A model swap while live audio is processing is not supported.

```powershell
& $py local-server\train_english_kws.py --apply
```

The script refuses installation when `eligible_to_apply` is false.
Otherwise it writes and validates a fresh ZIP backup before switching to
candidate templates, then prints a restart message. Restart MSDS to load them.

Thresholds for this *predeployment gate* are at least **90% positive
recognition recall** and at most **5% UNKNOWN false alarms** on the holdout,
plus full keyword calibration. These are minimum developer acceptance checks,
**not clinical/safety certification**. Verify performance again on continuous
CCTV speech/background noise, log false alarms per hour and missed emergency
words, and keep multimodal emergency validation enabled.

### Troubleshooting

- `Camera slot-1 is not connected`: connect it in MSDS; check `/status`.
- `No usable audio track`: enable CCTV microphone or use audio-enabled RTSP.
- `No complete spoken word detected`: wait until `AUDIO READY`; speak
  closer; check camera audio codec, volume and room noise.
- `NOT APPLIED`: inspect counts, leave-one-out confusion and unseen heldout
  errors; retrain candidate with better samples without touching original.
- Audio clips/templates/backups are intentionally kept out of GitHub. Do
  not copy the original private recordings into issues, PRs or chat.

Do **not** use `POST /kws/auto-train` to update live models: the safe CLI
above requires backup and holdout validation before deployment.
