# MSDS face/body/hand tracing V2 — experimental visual upgrade

Branch: `feature/cctv-tracing-v2-stable-mesh-20261025`
Base: `feature/cctv-face-pose-hand-tracing-20261025`, which contains the
user's UI/voice-validation integration from commit `f542c15`.

## Visible changes

The Live Cameras view has a face-scan button. After enabling:

- **Face mesh:** higher-contrast facial oval, two eyes, eyebrows, lips,
  irises and translucent triangle mesh, smoothed across frames.
- **Mesh detail:** click **Detailed mesh** to switch to **Face outline**,
  then click again to restore the full wireframe. This changes drawing
  only, not the trained models.
- **Body pose:** clean body-only skeleton (face-joint lines are removed);
  confidence/presence filtering plus a maximum bone length suppresses
  implausible diagonals and floating limbs when the model loses a joint.
  Pose geometry is smoothed across frames.
- **Hands:** two-hand 21-keypoint skeletons and index-finger movement trails;
  trails reset on missed detections and sudden jumps. If **Hands 0** is
  displayed, the camera did not detect visible hands. Move an open hand
  clearly into frame, with better lighting, to test.
- **Object boxes:** hidden during visual tracing by default to reduce
  clutter. They can be shown again with the **Object boxes off/on**
  toggle. **Object detection still runs normally** and feeds existing
  safety logic; only its rendering is controlled.
- **Expression estimate:** displayed in the controls row, away from
  faces and timestamps. It comes from the existing expression detector.
  High percentages are classifier scores, not a measure of real mood.

## Install on the Windows development PC

```powershell
cd "C:\Users\nazar\Documents\ongoin\06102026-kws"
git status --short
git fetch origin
git switch --track origin/feature/cctv-tracing-v2-stable-mesh-20261025
npm.cmd ci
npm.cmd run build
npm.cmd test -- --run
npm.cmd run electron:dev
```

If this branch already exists locally, use
`git switch feature/cctv-tracing-v2-stable-mesh-20261025`.

Do not switch branches with uncommitted changes that Git could overwrite.
Commit or stash source edits first. Keep `noise-only-slot1.wav`, passwords,
and recordings out of Git.

Navigate to **Live Cameras**, enable AI monitoring for a connected camera,
then enable **landmark tracing**. You can toggle Face mesh, Body pose, Hands,
the mesh detail mode and object boxes independently. The first use downloads
official MediaPipe tasks WASM/models; an internet connection is needed.
Do not interpret a low FPS or an invisible hand as an emergency.

## Methodological and safety scope

This version upgrades **overlay quality**, not recognition accuracy.
It does not classify inner feelings, track identity across cameras, persist
facial landmarks, send faces to an external service, change KWS, change fire
validation or auto-dispatch alerts. Existing RTSP/WebRTC session ownership is
unchanged. Landmark models may be wrong when partially occluded, seated,
moving fast, in poor lighting or very close to the CCTV lens.

Visible model inference is throttled to about three cycles per second per
enabled camera and executes synchronously in the renderer. For sustained
production use with many simultaneous cameras, GPU/worker-based scheduling
and actual frame-time profiling are still advisable. Assess performance
in a controlled environment before including success claims in the thesis.

Suggested evaluation: landmark completeness, proportion of clean pose
connections, observed overlay processing FPS, overlay alignment error,
behavior under occlusion and low light, and whether the existing validated
emergency triggers are unchanged.
