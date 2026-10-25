# MSDS — Face Mesh facial movement cues (experimental)

Branch: `feature/cctv-blendshape-expression-cues-20261025`.
Base: `fix/cctv-face-landmark-visibility-fallback-20261025`, the camera
branch whose screenshot showed **Face lines 124 (MediaPipe 478)**.

## What this adds

The live CCTV camera's already-working **478-point MediaPipe face
landmarker** now outputs 52 facial **blendshape coefficients** in addition
to the visible mesh. Coefficients measure estimated facial movement,
not the probability that a person *feels* a given emotion.

The new `Face movement` label in the **Trace** controls displays:
- Smiling (bilateral mouth-smile coefficients),
- Mouth open (jaw-open coefficient),
- Eyes widened (bilateral eye-wide coefficients),
- Brows raised (brow-inner-up coefficient),
- Brows lowered (bilateral brow-down coefficients),
- Lip corners lowered (bilateral mouth-frown coefficients), or
- No dominant facial movement (valid full coefficient set, no strong cue).

A percent next to a cue is **blendshape activation**, **NOT facial
expression-classifier accuracy** and **NOT psychological confidence**.
The system requires a short two-of-three temporal consensus to avoid
a single unreliable frame suddenly showing a new label.

The existing `face-api` facial-expression estimate (e.g. `neutral
99%`) remains visible for comparison and continues to support the
original multimodal validation. It is **not automatically replaced**
with blendshape guesses. When facial landmarks, blendshape coefficients,
or face visibility disappear, the new label clears rather than
remembering the last expression.

### Why no automatic emergency-alert fusion?

Different people can look frightened, neutral or angry without
experiencing those emotions, and looking neutral does not prove safety.
Simple blendshape rules are **heuristics**, not a trained/calibrated
emotion classifier. Adding them as a new emergency trigger before
testing would risk false alerts. KWS, fire/smoke alerts, camera
connections, and the existing facial-validation path remain unchanged.

## Windows installation

Close the running MSDS/Electron window and the old development server.

```powershell
cd "C:\Users\nazar\Documents\ongoin\06102026-kws"
git status --short
git fetch origin
git switch --track origin/feature/cctv-blendshape-expression-cues-20261025
npm.cmd ci
npm.cmd run build
npm.cmd test -- --run
npm.cmd run electron:dev
```

If the branch already exists locally, run
`git switch feature/cctv-blendshape-expression-cues-20261025`.
Do not discard uncommitted edits, .env, or local camera recordings.

Go to **Live cameras** -> your connected camera -> enable **Face mesh**
(the face scan toggle). Look at `Face movement` in the trace control
bar. Hold a relaxed face, smile naturally, open your mouth, widen your
eyes and raise your eyebrows for a couple of camera inference cycles
per gesture. Avoid assuming every subtle facial movement will cross
the provisional threshold.

When the face detector is running but the new label stays
`Analyzing…`, check the Electron DevTools Console and confirm a
working face model loaded. The MediaPipe 68-point fallback can draw
face contours when full mesh fails, but the fallback does **not**
output 52 blendshape coefficients, so the movement label may be
unavailable in that case.

## Research validation required

Test representative, consented indoor footage from different participants,
camera angles, distances, lighting and facial occlusions. Evaluate
each cue's sensitivity and false-positive rate with independently
human-annotated movement labels. Report a confusion matrix for
movement patterns separately from the existing 7-class face-api
expression classifier. Document the detection FPS and rate of
`Analyzing` (abstention) states. Do not label blendshape activation
as a scientifically calibrated emotion probability or thesis
accuracy figure.
