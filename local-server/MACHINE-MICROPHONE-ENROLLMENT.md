# Machine microphone enrollment for every MSDS CCTV camera

**No CCTV camera is required to train the shared model.** The original CCTV
endpoint remains available for optional in-camera enrollment. It cannot
capture if the backend camera registry is empty.

This independent workflow records the computer's built-in or external
microphone. It uses the same 16 kHz mono PCM, speech segmentation and
log-Mel/DTW feature extraction as the CCTV KWS validation pipeline.
Training templates are global to the MSDS camera service: connected
cameras read one shared recognizer and do not need separate training.

## One-time Windows PowerShell setup

From the updated project checkout:

~~~powershell
cd "D:\Users\nazar\Documents\ongoin\06102026-kws"
git pull --ff-only origin feature/msds-next-updates-20261013

$py = "D:\Users\nazar\Documents\ongoin\remix-of-sentry-vision-main\local-server\.venv\Scripts\python.exe"

& $py -m pip install -r ".\local-server\requirements-machine-kws.txt"
& $py ".\local-server\enroll_machine_kws.py" --list-devices
~~~

In Windows Settings > Privacy & security > Microphone, grant access to
desktop recording applications. If needed, pass --device followed by one
of the listed device indexes.

If an MSDS Python server is already running on port 5000, restart it from
the **updated project** before enrolling. The computer enrollment tool
checks /kws/status.data_dir against its local template directory to ensure
the running server and command share precisely the same model. If the
server is using a different checkout, the CLI refuses to train the wrong
model. If the server is offline, local recording/enrollment still works,
but start or restart the updated bridge before CCTV recognition.

## Enter -> speak -> approve -> save

~~~powershell
& $py ".\local-server\enroll_machine_kws.py" --keyword help --samples 5
~~~

1. Press Enter in the terminal.
2. Wait for LISTENING, say **Help** ONCE into your COMPUTER microphone,
   and pause briefly.
3. The Windows recording is played back for review when available.
4. Enter **y** only if the captured audio clearly contains the correct
   label. Any other response discards that attempt without saving.
5. After SAVED, press Enter for the next accepted sample. The tool
   rejects low-volume, clipped, or invalid-length utterances.

No permanent raw WAV is saved; only KWS feature templates (.npy) persist.
An archive of the previous templates is created in kws-backups first.
A matching running bridge immediately reloads accepted templates.

~~~powershell
& $py ".\local-server\enroll_machine_kws.py" --keyword fire --samples 5
& $py ".\local-server\enroll_machine_kws.py" --keyword emergency --samples 5
& $py ".\local-server\enroll_machine_kws.py" --keyword unknown --samples 10
~~~

Supported English labels: help, fire, emergency, danger, intruder,
police, ambulance, stop, and unknown. UNKNOWN means **ordinary,
non-emergency words and phrases**. The global model's hard limits are
10 positive templates per label and 40 UNKNOWN; the CLI refuses to
replace existing samples once a label has reached capacity.

## Verify with unseen computer-mic speech

~~~powershell
& $py ".\local-server\enroll_machine_kws.py" --keyword help --verify
~~~

This captures one new word and prints its matched candidate, confidence,
and ACCEPTED or REJECTED decision. It does not create a template or
modify the model. To be considered open-set ready, the KWS engine needs
at least three templates for a positive keyword and five UNKNOWN samples.
Test other keywords and non-emergency speech too: matching a training
speaker once does not demonstrate real-world reliability.

## Use the trained model on connected CCTV cameras

After enrollment, connect any CCTV through the MSDS app. Every connected
camera with working RTSP microphone audio runs the same trained
KWS_ENGINE. You may connect Camera 1, Camera 2, Camera 16, or any
registered camera; the enrollment source never limits camera detection.
Unlike computer-mic recording, live CCTV validation still requires a
camera's audio worker to be streaming.

~~~powershell
$st = Invoke-RestMethod "http://127.0.0.1:5000/status"
$st.custom_kws | Select-Object ready_keywords, negative_ready, open_set_ready

$st.cameras | ForEach-Object {
    [PSCustomObject]@{
        Camera = $_.id
        Video = $_.ffmpeg
        Audio = $_.audio.connected
        Worker = $_.audio.thread_running
        Candidate = $_.audio.custom_kws.last_candidate
        Decision = $_.audio.custom_kws.last_decision
    }
}
~~~

**Safety:** Disable external emergency notifications during enrollment.
Microphone quality, distance, reverberation, and RTSP codec differences
may reduce CCTV accuracy even if machine-microphone validation succeeds.
Use independent speakers and held-out CCTV recordings to measure misses
and false alarms before enabling live safety alerts.
