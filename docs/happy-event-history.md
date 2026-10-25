# Happy expressions in MSDS Event History — October 25, 2026

Branch: `fix/event-history-happy-smile-recording-20261025`.
Base: `fix/history-direct-significant-events-no-validation-20261025`.

## Problem
Event History always read `0` when a person smiled because the
significance filter rejected all `emotion` events. In live CCTV
tests, the face-api model sometimes estimated `Neutral` even while
MediaPipe's 478-point face mesh visibly followed a smile.

## Fix
An explicitly observed **Happy** visual-expression event can be kept as
informational history, with no safety keyword or validation requirement.

Two independent sources can produce it:

1. The existing face-api facial-expression pipeline emits an
   `emotion` event with `label: 'Happy'` when confidence is sufficient.
2. While the user has explicitly enabled the Live Cameras Face Mesh,
   the existing MediaPipe blendshape detector may report a *stable
   bilateral smile* after its temporal consensus (at least 2 of 3
   observations). A smile activation of at least 0.60 saves a
   `Happy` history entry along with a camera snapshot, even if the
   face-api expression estimate remains Neutral. The blendshape
   activation is not an emotion-class probability.

Other emotional-expression estimates, especially Neutral, remain
excluded from the incident-focused history. The Happy threshold is
0.60; duplicate Happy entries on the **same camera** are suppressed
for 120 seconds. Other significant visual incidents retain their
previous 45-second cooldown; verified alarms are not cooled down.

**Safety boundary:** A Happy record is a *visual observation* and
must not trigger Camera Alerts, auto-dispatch, emergency notifications,
KWS acceptance or facial distress fusion. Facial geometry and
expression classifiers cannot establish a person's actual inner mood.

## Windows setup
Close Electron / the current development server, then:

```powershell
cd "C:\Users\nazar\Documents\ongoin\06102026-kws"
git status --short
git fetch origin
git switch --track origin/fix/event-history-happy-smile-recording-20261025
npm.cmd ci
npm.cmd run electron:dev
```

If the branch is already local, use:
`git switch fix/event-history-happy-smile-recording-20261025`.
Preserve any uncommitted changes first. Do not accidentally commit
recorded CCTV audio (`noise-only-slot1.wav`) or camera credentials.

## Field check
Open Live Cameras on your CCTV, switch on the face-scan icon and
Face mesh, then make a sustained, clear smile for at least two
tracking cycles (prefer a few seconds). Event History should show
**😊 Happy** with camera name, timestamp, confidence and a snapshot
where video capture is available. No keyword is needed. Keep smiling:
the counter should NOT rise again for two minutes on the same camera.
A neutral face should not create a new event. Verify another camera
is handled independently.

The old expression classifier's `Neutral (99%)` readout can coexist
with MediaPipe's `Smiling` estimate; that is not an internal
contradiction in the UI, because they are independent and uncalibrated
visual models.

Run `npm.cmd run build` and `npm.cmd test -- --run` to check the
frontend locally. Automated tests cover significance, cooldown,
UI display and the blendshape history callback. **No live field
accuracy claim** follows from the tests.
