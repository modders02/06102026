# MSDS Custom Streaming Audio Engine (Experimental)

This branch adds an MSDS-owned low-latency safety-word recognizer that does not
use Whisper or another speech-to-text model for keyword detection.

## Pipeline

```text
CCTV RTSP audio
  -> FFmpeg 16 kHz mono PCM
  -> small PCM blocks (~128 ms)
  -> energy VAD
  -> 32-bin per-frame-normalized log-Mel features
  -> cosine Dynamic Time Warping (DTW)
  -> enrolled keyword confidence
  -> existing multimodal fusion
```

The same camera audio connection is reused. There is no second RTSP session.

The engine requires at least 3 enrolled examples of a keyword before it will
detect that keyword. Five to ten samples per word, from more than one speaker
when possible, are recommended for real evaluation.

Suggested first words:

- `help`
- `tulong`
- `sunog`
- `magnanakaw`

The scream detector remains a separate waveform detector.


> **v2 note:** The feature representation changed from v1. Existing samples in `local-server/kws-data/` are intentionally not reused. Re-enroll each keyword into the new `local-server/kws-data-v2/` store before testing v2.

## Recognition modes

`MSD_AUDIO_ENGINE=hybrid` (default on this experimental branch)

- custom engine detects trained safety keywords with low latency
- Faster-Whisper continues to provide unrestricted English/Tagalog live text
- a Whisper event duplicating a just-detected custom keyword is suppressed

`MSD_AUDIO_ENGINE=custom`

- Faster-Whisper is not loaded or called
- only trained custom keywords appear as transcription events
- use this mode to measure the custom engine independently

## Install

From the repository root in PowerShell:

```powershell
.\local-server\.venv\Scripts\python.exe -m pip install -r .\local-server\requirements.txt
```

NumPy is the only new dependency required by the custom feature extractor and
DTW matcher.

## Train from the live CCTV microphone

Start the app, leave Camera 1 connected, then inspect the engine:

```powershell
Invoke-RestMethod "http://127.0.0.1:5000/kws/status" | ConvertTo-Json -Depth 6
```

Arm one enrollment:

```powershell
Invoke-RestMethod -Method Post "http://127.0.0.1:5000/cameras/slot-1/kws-enroll/help"
```

Immediately say **help** once into Camera 1, then stay quiet briefly. Check the
camera KWS state:

```powershell
((Invoke-RestMethod "http://127.0.0.1:5000/status").cameras |
  Where-Object id -eq "slot-1").audio.custom_kws |
  ConvertTo-Json -Depth 8
```

Repeat the POST + spoken word at least three times. Do the same for the other
keywords:

```powershell
Invoke-RestMethod -Method Post "http://127.0.0.1:5000/cameras/slot-1/kws-enroll/tulong"
Invoke-RestMethod -Method Post "http://127.0.0.1:5000/cameras/slot-1/kws-enroll/sunog"
Invoke-RestMethod -Method Post "http://127.0.0.1:5000/cameras/slot-1/kws-enroll/magnanakaw"
```

Issue one request, say that one word, wait for `state: captured`, then issue
the next request. Do not send all enrollment requests at once.

Enrollment speech is suppressed from emergency events so training `help` or
`sunog` does not intentionally raise an alarm.

## Test without Faster-Whisper

Stop the app, then in the same PowerShell window:

```powershell
$env:MSD_AUDIO_ENGINE="custom"
npm.cmd run electron:dev
```

Now say an enrolled keyword. The local-server log should show a line like:

```text
[KWS slot-1] tulong: 0.91 (720 ms segment, 12.4 ms processing)
```

The exact numbers depend on the microphone, speaker and CPU.

The audio status exposes:

- `last_keyword`
- `last_confidence`
- `last_detected_at`
- `last_processing_ms`
- enrolled-template counts
- ready keywords

## Reset a keyword

```powershell
Invoke-RestMethod -Method Delete "http://127.0.0.1:5000/kws/templates/help"
```

Runtime acoustic templates are saved under `local-server/kws-data-v2/`. That
directory is gitignored because the samples are installation-specific and
derived from local voice recordings.

## Evaluation

Do not judge accuracy from positive words only. Test at least:

- enrolled keywords from near/far distances
- different speakers
- quiet and shouted speech
- fan/air-conditioner noise
- TV speech
- ordinary English/Tagalog conversation
- confusing words such as `hello`, `halo`, `sun`, and `tulog`
- silence

Record true positives, false positives, false negatives, confidence, and
`last_processing_ms`. Those measurements should determine the final
threshold and whether the custom engine is suitable for the alert path.
