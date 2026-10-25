# CCTV Face Mesh visibility fix and 68-point fallback

Base: `fix/cctv-tracing-visible-landmarks-20261025`.
Branch: `fix/cctv-face-landmark-visibility-fallback-20261025`.

## Actual observed problem
User's CCTV screenshot (25 Oct 2026) clearly showed:
`Face 1 · Body 1 · Hands 0 · Face lines 0 · Pose bones 4 · Face geometry unavailable`.

This means MediaPipe was reporting a face but the canvas was NOT rendering
usable face geometry. Prior iterations changed line weight, detail and
smoothing without addressing the underlying geometry contract.

## Root fix

`src/lib/landmarkRendering.ts` originally rejected ALL connections with
`visibility < 0.45`. **MediaPipe's face/hand tasks do not consistently
provide a meaningful visibility confidence per individual landmark.**
In some runtimes this unsupported value is reported as `0`, so every
valid point was thrown out. Similarly the bounds calculation excluded
zero-visibility points.

`imageLandmarks()` now deliberately keeps **only normalized x/y** for
face and hand geometry; no unsupported visibility value is applied.
MediaPipe's independently predicted pose visibility scores are still
checked for safety and rendering quality.

`usableFaceLandmarks()` validates finite/in-frame normalized geometry,
and the full FaceLandmarker tessellation/contours are rendered again.
The face bounds are calculated from usable normalized geometry.

## Independent fallback when MP geometry is broken

If MediaPipe still renders fewer than 16 facial line segments,
`src/lib/faceLandmarkFallback.ts` lazily loads the **already-installed**
`@vladmandic/face-api` tiny face detector and tiny 68-point landmark
model. It obtains 68 keypoints from the SAME visible CCTV video element
(no second stream, no face identification or embedding), and draws their
eyes, brows, mouth, nose and jaw. This path is opt-in with the overlay,
and it is not used when Face Mesh renders properly. The status reports
`face-api 68 fallback` if it has to take over.

This supplementary detector may download its model weights from jsDelivr
on initial use and needs network connectivity unless the model files are
packaged locally. It may use CPU/GPU resources alongside the existing
expression model. If it fails to load, the camera and safety monitoring
continue; the overlay reports unavailable geometry instead of displaying
invented face points.

## Body pose: stop drawing unattached triangles

The low-angle CCTV sometimes reports a pose even if limbs cannot be
localized. The overlay now requires a reasonably visible, separated
shoulder pair before drawing its skeleton; wrist trails also require
at least five connected body segments. When unavailable it reports
`Body partly occluded / unreliable` rather than drawing misleading
wrist triangles near the face.

This remains a **visualization change only**. KWS, emergency
acceptance, fire/smoke detection, event validation and face emotion
scores are untouched.

## Run on Windows

Close the running MSDS/Electron dev server. From PowerShell:

```powershell
cd "C:\Users\nazar\Documents\ongoin\06102026-kws"
git status --short
git fetch origin
git switch --track origin/fix/cctv-face-landmark-visibility-fallback-20261025
npm.cmd ci
npm.cmd run build
npm.cmd test -- --run
npm.cmd run electron:dev
```

If local branch already exists, run:
`git switch fix/cctv-face-landmark-visibility-fallback-20261025`.

Do not change branches if this would discard uncommitted source edits.
Keep raw CCTV recordings, credentials, and `noise-only-slot1.wav`
out of Git.

Click the face-scan icon for **Camera 1** in Live cameras, then select
**Face mesh** and **Detailed mesh**. Expected diagnostic behavior:

- `Face lines N (MediaPipe 478)`: primary 478-point tracing is working;
- `Face lines N (face-api 68 fallback)`: MediaPipe geometry is failing,
  but the fallback detector is drawing 68-point facial contours;
- `Face lines 0 (no usable landmarks)`: both failed or no sufficiently
  clear face is visible. Read Electron DevTools Console for missing models.
- `Pose bones 0 · Body partly occluded / unreliable`: the system is
  avoiding unsupported body tracing, not claiming there is no human.

The code contains automated tests for the exact observed
`visibility: 0` regression and fallback coordinate conversion.
**Passing GitHub CI is not proof of successful real-world performance**:
check actual contours on video, several angles, partial occlusion and
dark indoor lighting before making thesis claims.
