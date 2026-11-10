# Facial-expression Event History

**Branch:** `fix/event-history-facial-expression-logging-20261110`

MSDS Event History records stable changes in the face-expression classifier's
dominant label. It does not claim to infer a person's actual mood, intent,
mental state, or emergency condition.

## Categories

| Model expression | Event History label |
|---|---|
| happy | Happy |
| sad | Sad |
| angry | Angry |
| fearful / fear | Frightened |
| surprised / shock | Surprised |
| neutral | Neutral |
| disgusted | Disgust |

Surprised/ Shock is deliberately distinct from Frightened. It cannot satisfy
the facial-expression half of an emergency wake-word pairing.

## Recording behavior

- Confidence must be at least 55%.
- The same label must be dominant for two consecutive face-analysis frames.
- A label is recorded once when it becomes the stable expression for that
  visible-face session; it is not re-recorded on every analyzed frame.
- A different stable label creates a new informational history entry.
- When the face leaves the frame, the expression session resets.
- Expression events are stored as `emotion` history records with a camera,
  timestamp, confidence, and available frame snapshot.

Expression history never creates a Camera Alert, email, or emergency clip.
Those remain governed by the independent accepted audio + matching camera
validation path. Ordinary person/object detections and saliency changes remain
excluded from Event History.

## Local validation

```powershell
npm.cmd test -- --run src/test/emotionEvents.test.ts src/test/significantEvents.test.ts src/test/multimodalDistress.test.ts src/test/historyValidationView.test.tsx
npm.cmd run build
```

In live CCTV testing, hold a clear expression in view until the two-frame
stability check completes, then change expression. Confirm one history entry
per stable transition and no new Camera Alert from the expression alone.
