# V4 crop listening audit — verify the automatically extracted keyword is intact

Branch: \`experiment/kws-v4-crop-playback-audit-20261031\`
Parent: \`experiment/neural-kws-v4-temporal-cnn-20261031\`

## Why this is next

Both V3 and V4 evaluate the same 35 emergency-word recordings and ten
UNKNOWN clips from a single-speaker new session. V3 accepted 11/35 and
V4 accepted 7/35. File-by-file comparison showed:
- 20/35 both failed
- 8/35 newly failed with V4
- 4/35 newly succeeded with V4
- 3/35 both correct.

V4 accepted 0/5 EMERGENCY and 0/5 INTRUDER, whereas the original
2.5-second WAVs were manually listened to and accepted by the operator.

The V4 train preprocessor uses a label-independent energy-contrast crop,
typically 0.6–0.9 seconds. Its acoustic feature audit verifies the crop
can generate ordered Log-Mel features; **it cannot verify the crop still
contains a complete spoken keyword**. That must be tested before blaming
only the temporal CNN or raising its capacity.

## Procedure (Windows PowerShell)

Do not touch the working V4 or V3 models:

    cd "C:\Users\nazar\Documents\ongoin\06102026-kws"
    git status
    git fetch origin
    git switch --track origin/experiment/kws-v4-crop-playback-audit-20261031

If the branch already exists, switch to it and \`git pull --ff-only\`.

Start with the classes that regressed most, EMERGENCY and INTRUDER,
and FIRE, which remains weak:

    .\local-server\audit_noise_kws_v4_crops.cmd

For more classes, explicitly select them:

    .\local-server\audit_noise_kws_v4_crops.cmd --label police --label ambulance --label help --limit 5

The first run chooses the five EMERGENCY, five INTRUDER and five FIRE
recordings from **the same 45-file V4 validation set**. For each WAV:

1. Listen to the original recording played directly from disk via memory.
2. Listen to its V4-extracted crop played from memory.
3. Enter \`Y\` only if the crop audibly includes the COMPLETE expected word.
   Enter \`N\` if clipped, missing, wrong sound, or not a complete word.
   Enter \`U\` if uncertain, \`R\` to replay both, or \`Q\` to stop safely.
4. The result is appended to a private, Git-ignored CSV. Existing reviewed
   recordings are skipped if you rerun it.

You may use \`--only-errors\` to prioritize V4 failed classifications.
The script refuses to compare against a changed manifest or a model whose
metadata doesn't match the training report. It verifies training and
validation membership fingerprints, original WAV SHA hashes, label order,
and the same grouped split.

## Output and interpretation

Private log:

    local-server/neural-kws-data/artifacts/noise_temporal_cnn_v4.crop-review.csv

No source WAVs, new WAV files, model parameters or event history are saved
or modified; Windows playback occurs from in-memory PCM16 WAV buffers.
The private CSV contains only WAV paths, SHA hashes, crop start/end,
operator verdict and the saved V4 prediction. Never commit these records
or upload personal voice recordings.

If many incorrect keyword predictions correspond to \`N\`, the V4 speech
candidate localization stage is damaging the signal. Fix and validate it
with training audio only and collect new evaluation data afterward.

If most incorrectly predicted segments are \`Y\`, improve classification
training/data diversity and investigate recording-session shift, rather
than assuming trimming is the primary cause.

If most crop verdicts are \`Y\` but POLICE is ranked correctly and rejected,
that is an independent confidence calibration problem; **do not relax the
fixed emergency threshold using the already-used validation recordings**.

This is a diagnostic on development validation recordings, not a new
independent evaluation. Do not activate V4 for operational emergency alerts.
Stable DTW templates, real alerts, active KWS and V3 are untouched.
