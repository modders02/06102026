# MSDS — Event History records significant incidents only

Base branch: `feature/cctv-blendshape-expression-cues-20261025`.
Change branch: `fix/event-history-significant-only-20261025`.

## What changed

Event History is now **an incident log, not a frame-by-frame detections log**.
In `src/pages/Index.tsx`, a centralized filter rejects routine detections
**before** they are persisted through `useCameraRegistry.addEvent`.

The following are saved in Event History:
- **Validated multimodal distress** (accepted matching emergency keyword and
  current compatible facial-expression evidence).
- **Validated fire** (accepted `fire` keyword + confirmed live large fire).
- **Detector-confirmed visual fire**, even without a word, as a **history-only**
  incident with a pending voice validation; it is not an accepted Camera Alert.
- **Detector-confirmed visual smoke** with confidence >=55%, even when no
  smoke+word combination is configured. It is also history-only.
- **High-confidence (>=75%) person collapse/fall anomalies**, only when the
  specific motion label indicates a fall/collapse, and as history-only until
  any separate alert requirements are satisfied.

These do **not** create Event History records:
- Routine person/object sightings or ordinary changes in object count.
- Saliency score/attention threshold crossings, including `Salient scene`.
- Neutral, happy or other single facial-expression estimates (even high scores).
- Raw/unverified wake words, speech candidates or ordinary microphone sounds.
- Generic camera motion or low-confidence anomaly detections.
- Rejected/unconfirmed fire candidates and inconclusive fusion attempts.

**Repeated visual-only incidents** are deduplicated per-camera/per-type within
45 seconds, including fire label changes such as night vision. Two separately
verified multimodal emergency triggers are never merged or suppressed by this
history cooldown. Existing alert fusion, emergency notification and video
recording requirements are unchanged.

The Event History UI and per-camera history counters ignore routine **legacy**
history entries; older data is not deleted from storage by this update, and
the **Clear event history** button remains available for manual deletion.
Camera Alerts continue showing the newest accepted trigger, while older
accepted triggers and recording updates remain available as history.

## Install on Windows

Close the MSDS/Electron development process before switching branches:

```powershell
cd "C:\Users\nazar\Documents\ongoin\06102026-kws"
git status --short
git fetch origin
git switch --track origin/fix/event-history-significant-only-20261025
npm.cmd ci
npm.cmd run build
npm.cmd test -- --run
npm.cmd run electron:dev
```

If the branch already exists locally, use
`git switch fix/event-history-significant-only-20261025`.
Do not switch while uncommitted source changes could be overwritten.
Do not add `noise-only-slot1.wav` or camera credentials to Git.

## Acceptance checks

1. Leave an ordinary person sitting in front of Camera 1 for several minutes.
   The live object detector and saliency scores must still update. Event
   History should **not** grow.
2. Change facial expression to neutral, smile or look aside. The visual
   diagnostic may change, but Event History should not record it.
3. Create a controlled, simulated confirmed fire/smoke input through an
   authorized test fixture (do not start a real fire). One visual-history
   incident should be saved, then repeated detections should be suppressed.
4. In a safe test environment, supply an accepted keyword plus matching
   camera evidence. Existing validated Camera Alerts must still work.
5. Test a second legitimate accepted trigger: it must not be suppressed
   by the visual-only deduplication rule.

## Research limitations

Event significance is a deliberately conservative operational policy.
It does not establish whether a real-world emergency occurred. The visual
fire/smoke detector and collapsed-person classifier may still give false
positives; use consented and ground-truth-labeled recordings to evaluate
false alerts per hour and missed incidents. Filtering the history does
not improve model accuracy. This release doesn't retroactively delete
user's old history and doesn't change CCTV recording policies outside
this Event History pipeline.
