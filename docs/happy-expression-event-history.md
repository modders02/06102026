# MSDS — High-confidence Happy estimates in Event History

Branch: `fix/event-history-happy-expression-20261025`
Base: `fix/history-direct-significant-events-no-validation-20261025`

## Why Happy was missing

The previous incident-only filter intentionally rejected **all**
`emotion` events to prevent a new history entry for every routine face
frame. This also excluded Happy even while facial-expression tracking
was running. The underlying `@vladmandic/face-api` detector already
provides a `happy` classifier output; face-mesh tracing and MediaPipe
movement cues are separate tools.

## New behavior

Event History now accepts the **Happy expression estimate** only when:

- A visible face is detected by the existing face-api expression model.
- Its top classifier label is `happy` for **two consecutive processed
  facial observations**.
- The Happy classifier confidence is **at least 80% in both frames**.
- A Happy event on the same camera has not already been recorded in the
  past **45 seconds**.

While the expression remains Happy, only **one event per continuous
observation** is emitted by the camera pipeline, even after 45 seconds.
An interval of Neutral, another expression, or no face rearms the
episode detector; a new episode after the cooldown can enter history.
Normal object/person detections, low-confidence expressions, Neutral,
raw wake words and saliency remain excluded.

A Happy history entry contains camera, time, snapshot (when available),
classifier label and score. It is **not a mood diagnosis or proof of
actual happiness**. A smile may be present even if face-api classifies
a frame as Neutral; a separate MediaPipe "Smiling" movement cue is
shown live but is not silently relabeled as Happy.

**No validation step is required** for Happy history. The live
camera's separate speech/visual emergency Validation Layer continues
normally. Happy estimates **never** become Camera Alerts, emergency
notifications, or emergency recording triggers.

## Install on the development PC

Close MSDS/Electron and run:

```powershell
cd "C:\Users\nazar\Documents\ongoin\06102026-kws"
git status --short
git fetch origin
git switch --track origin/fix/event-history-happy-expression-20261025
npm.cmd ci
npm.cmd run build
npm.cmd test -- --run
npm.cmd run electron:dev
```

If the branch is already local, use:
`git switch fix/event-history-happy-expression-20261025`.

Preserve uncommitted changes before switching. Do not upload raw
recordings, `noise-only-slot1.wav`, or camera secrets to Git.

## Live checks

1. Open Live Cameras with AI enabled and a face sufficiently visible.
2. Observe a clear smile long enough for at least two facial analysis
   cycles. **If face-api reports Happy >=80%**, Event History should
   gain one **😊 Happy** record (no validation panel).
3. Keep the same expression: history must not grow every frame.
4. Return to Neutral, look away, or briefly leave frame. Neutral must
   not create history. A new high-confidence Happy episode may create
   another entry after the 45-second cooldown.
5. Check Camera Alerts: Happy must not appear there.

The thresholds are conservative experimental defaults, not validated
performance guarantees. Evaluate them with consented, held-out
participant footage before reporting classifier performance in a thesis.
