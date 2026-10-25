# CCTV landmark visibility recovery (V3 experimental fix)

This branch is based on `feature/cctv-tracing-v2-stable-mesh-20261025` and
keeps the previous two branches intact. It addresses a **visual regression**
seen in a real CCTV screenshot: `Face 1 · Body 1` was reported while
almost no mesh or body lines were visible.

## Changes

- **Restored MediaPipe's full `FACE_LANDMARKS_CONTOURS`** used in the earlier
  version instead of relying only on selected specialized subgroups.
- Restored **raw current-frame landmark coordinates** for rendering.
  The V2 temporal smoothing was experimental and could hide or misplace
  overlays; it is not used in this recovery build.
- Shows a dashed **facial landmark bounds** rectangle, derived from the
  in-frame landmark geometry, for visual feedback even when a model's
  topology is incomplete. Outlier points are trimmed; invalid bounds
  are not drawn. This is not a face-recognition/identity rectangle.
- Relaxed V2's very strict body visibility threshold from `0.64` to
  `0.32`, and increased its maximum normalized bone length from
  `0.38` to `0.64`. Implausible extremes are still rejected, but
  visible torso/arm joints should not be discarded as readily.
- Restored clear hand connections, while retaining bounded wrist and
  fingertip trails and the stale-trail reset.
- **New rendering diagnostics:** status displays `Face lines N [+ box]`
  and `Pose bones N`. Model detection counts alone do not guarantee
  that connected landmarks reached the display.

The UI remains per-camera opt-in. The existing MSDS face-expression scoring,
KWS emergency words, multimodal fusion and priority alerts are **not
modified**.

## How to test on Windows

Close all existing Electron/MSDS windows and stop the development process
before launching this branch:

```powershell
cd "C:\Users\nazar\Documents\ongoin\06102026-kws"
git status --short
git fetch origin
git switch --track origin/fix/cctv-tracing-visible-landmarks-20261025
npm.cmd ci
npm.cmd run build
npm.cmd test -- --run
npm.cmd run electron:dev
```

If the branch already exists, use:
`git switch fix/cctv-tracing-visible-landmarks-20261025`.
**Do not discard uncommitted changes** to switch branches.

Navigate to **Live cameras**, enable the face-scan icon for Camera 1,
and leave **Face mesh**, **Body pose** and **Detailed mesh** enabled.
Look for a prominent cyan face boundary and contours around the eyes,
nose and lips, with green pose lines at visible body joints.
If you still see `Face 1 · Face lines 0` or `Pose bones 0`,
take a screenshot showing the full video and status bar and report
the displayed values. That separates a model-geometry issue from
mere model-detection counts.

If your original V1 visual works better, safely switch back to:

```powershell
git switch feature/cctv-face-pose-hand-tracing-20261025
```

This patch has automated unit/integration checks, but it has **not been
field-tested on the user's own camera after this change**. Do not make
thesis performance claims from a successful build or a single frame.
Privacy, consent and the existing safety validation remain necessary.
