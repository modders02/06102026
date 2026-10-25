# MSDS — Event History without alert validation

**Branch:** `fix/history-direct-significant-events-no-validation-20261025`
**Parent:** `fix/event-history-significant-only-20261025`

## Intended behavior

**Event History and Camera Alerts have different rules.**

Event History keeps a time-stamped record of **significant camera-observed
incidents** without requiring accepted speech or a facial-validation match.
The Event History panel does **not** show an ACCEPTED/PENDING/REJECTED
validation status or "Validation at this event" section.

- Detector-confirmed visual fire >= 55%: logged even if the "fire"
  keyword was absent, pending, or rejected.
- Detector-confirmed visual smoke >= 55%: logged without requiring
  a configured smoke/wake-word fusion.
- High-confidence person fall/collapse >= 75%: logged from the current
  motion detector when its event label indicates a fall or collapse.
- Separately verified multimodal distress and fire alerts: preserved
  as Event History records after leaving the active Camera Alert slot.

Ordinary persons/objects, neutral or unvalidated facial expressions,
saliency changes, attention scores, and unverified speech candidates do
not fill Event History. Repeated standalone visual incidents on the
same camera are deduplicated for 45 seconds; distinct verified emergencies
are never deduplicated by this history cooldown.

**Camera Alerts, emergency popups, notifications, and emergency clip
recordings still require the original accepted speech + matching camera
evidence.** A visually confirmed fire or smoke entry in history is a
detector observation, not a verified emergency alarm. Rejecting an audio
candidate does not erase significant visual history or its camera
snapshot, but incomplete/rejected multimodal distress may not bypass
the existing emergency safety gate.

## How to run on Windows

First close Electron and the existing development process. Preserve any
uncommitted source changes before switching branches:

```powershell
cd "C:\Users\nazar\Documents\ongoin\06102026-kws"
git status --short
git fetch origin
git switch --track origin/fix/history-direct-significant-events-no-validation-20261025
npm.cmd ci
npm.cmd run build
npm.cmd test -- --run
npm.cmd run electron:dev
```

If the branch already exists locally, use
`git switch fix/history-direct-significant-events-no-validation-20261025`.

Keep CCTV recordings, `.env` secrets and `noise-only-slot1.wav` out of
Git. Existing local history is not automatically deleted: old routine
records are hidden by the significant-event display filter.

## Acceptance criteria

1. Live person/object/face/saliency updates continue as normal; no new
   Event History entry is generated for routine observations.
2. Use **simulated** visually confirmed fire or smoke test inputs:
   the confirmed incident enters Event History with its original
   snapshot even when the KWS/alert validation is rejected.
3. No validation subsection appears in Event History, although the
   separate live Validation Layer still shows its current state.
4. Significant visual-only events never appear as Camera Alerts.
   An independently accepted and compatible speech+camera pair still
   creates a Camera Alert.
5. A repeated confirmed visual incident on the same camera inside
   45 seconds is suppressed; a second separately accepted emergency
   is retained.

This adjusts history semantics; it does not improve detector accuracy.
Verify with safely staged test recordings before citing behavior in a thesis.
