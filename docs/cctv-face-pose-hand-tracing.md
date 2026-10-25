# Experimental CCTV face mesh, body pose and hand-motion traces

Branch: `feature/cctv-face-pose-hand-tracing-20261025`

## What was added

The Live cameras view provides an **opt-in Trace landmarks** control on
each online camera with AI detection enabled. It uses the **existing**
video element owned by the monitoring session; no additional RTSP/WebRTC
stream is started. When tracing is enabled the user can independently
toggle:

- **Face mesh**: face contours plus a sparse, translucent visualization
  of the full facial mesh (one visible face).
- **Body pose**: pose skeleton connections and bounded wrist motion
  trails (one visible person).
- **Hands**: 21-point hand skeleton and bounded index-fingertip traces
  (up to two visible hands).

The tracing overlay aligns normalized coordinates to the
`object-fit: contain` video rectangle, accounting for pillarbox or
letterbox margins. Landmark trails are in volatile component memory
and are cleared when detection is lost, when a mode is disabled or
when navigating away from Live cameras.

The adjacent **Expression cue (not mood)** uses the existing
`useFaceDistress` classification when its confidence is at least 0.55.
This label is **not** produced by the tracing models, is not a
psychological diagnosis, and is not a new alert trigger.

### Model and runtime requirements

- Dependency: pinned `@mediapipe/tasks-vision@1.1.1`.
- Requires an internet connection **the first time** the task
  WASM and model files are fetched from official Google model hosting
  and jsDelivr. Offline/isolated deployment requires bundling the
  model/WASM assets locally and revising URLs.
- The browser must support WebAssembly and read the camera video
  pixels. Models execute inside the local renderer; no CCTV frames
  are intentionally uploaded by this feature, although third-party
  CDNs receive requests for model downloads.
- CPU execution and an upper target of about **three tracking cycles
  per second** limit load when several cameras and existing AI
  detectors already run; performance depends on camera resolution,
  available RAM and CPU/GPU. Vision tasks execute synchronously on the
  renderer, so latency should be checked in field trials.
- Model loading/errors appear inside the video instead of crashing
  the camera player. Disable and re-enable tracing to retry.
- Tracking is an ephemeral, frame-to-frame visualization. Index keys
  are **not identity IDs**: there is no face recognition, person
  identification, cross-camera association, or storage of biometric
  templates.

## Installation and operation

```powershell
cd "C:\Users\nazar\Documents\ongoin\06102026-kws"
git status
git fetch origin
git switch --track origin/feature/cctv-face-pose-hand-tracing-20261025
npm.cmd ci
npm.cmd run build
npm.cmd test -- --run
npm.cmd run electron:dev
```

If the branch already exists locally, use
`git switch feature/cctv-face-pose-hand-tracing-20261025`.
**Do not switch while uncommitted changes are present**; first
commit or safely stash them (do not add camera credentials/recordings).

In MSDS select **Live cameras**, start a connected camera with AI
enabled, and press **Enable landmark tracing** (face icon) in that
camera's header. Face mesh, Body pose, and Hands are initially all
enabled, with independent toggles underneath the header. Click the
face icon again to stop all tracing. The controls are disabled for
offline cameras or disabled AI.

## Research and safety boundaries

This is an **experimental visual demonstration**, not evidence that
the system reliably detects subjective mood or predicts emergencies.
The existing speech+facial validation logic is unchanged. Real
distress cannot reliably be inferred from one facial expression;
neutral expressions must not be treated as evidence of safety.
Measurements to report separately: pose/landmark detection coverage,
occlusion robustness, per-camera throughput (FPS/latency), expression
classification accuracy on consented data, and false alerts per hour.
Test dark rooms, glasses, facial occlusion, multiple people, and weak
camera feeds with the actual CCTV microphone/video. Obtain consent
and maintain local retention controls for any recordings.
