# English emergency KWS training dataset

This branch follows the manuscript's **English-only** language scope. The previous
Tagalog-trained runtime is preserved on `tagalog-kws-experimental`.

Place real household/CCTV microphone recordings in these folders:

```text
kws-training-english/
  help/*.wav
  fire/*.wav
  emergency/*.wav
  danger/*.wav
  intruder/*.wav
  police/*.wav
  ambulance/*.wav
  stop/*.wav
  unknown/*.wav
```

Use at least **5 varied real recordings per emergency word** and at least **10
UNKNOWN/non-keyword recordings** for a useful first validation set. Record
different speakers, normal and urgent delivery, realistic camera distance, and
ordinary indoor noise. Do not use text-to-speech as the only training source;
the panelist specifically requested realistic conditions.

The trainer accepts uncompressed 8-bit or 16-bit PCM WAV, mono or stereo, and
normalizes it to the runtime's 16 kHz mono signed-int16 format automatically.

Run from the repository root:

```powershell
python local-server/train_english_kws.py
```

or call the local service after it is running:

```powershell
Invoke-RestMethod -Method Post "http://127.0.0.1:5000/kws/auto-train" `
  -ContentType "application/json" `
  -Body '{"reset":true}'
```

The training report contains per-class sample counts, rejected WAV files,
leave-one-out confusion results, and `production_ready`. Do not claim the
keyword model is validated until `production_ready` is true and a separate
held-out realistic-condition test set has also been evaluated.
