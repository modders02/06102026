# Prevent Surprised being verified as Frightened (28 October 2026)

**Branch:** `experiment/deepfilternet-sherpa-kws-20261028`  
**Original stable branch:** `stable_branch_271026` (not modified)

## Observed bug

The CCTV example showed a **Surprised** Event History entry at about 60% confidence, alongside a Camera Alert claiming **Verified distress: Frightened + "emergency"** at the same timestamp. The alert-verification helper had explicitly mapped `surprised` / `surprise` / `shock` / `shocked` to **Frightened**. The Event History module already distinguished surprise from fear, making the result inconsistent.

## Corrected behavior

- Only actual classifier labels `fearful`, `fear`, and `frightened` map to **Frightened** in the emergency-fusion pathway.
- `surprised`, `surprise`, `shock`, and `shocked` are **never sufficient** to validate any distress keyword, regardless of confidence.
- **Surprised** remains a normal Event History entry and does not itself create a Camera Alert.
- A fresh non-qualifying face clears previously cached Angry/Frightened evidence, even if that new face is below the 55% facial acceptance threshold. This prevents a previous face from confirming a later keyword after the face has changed.
- Real explicit Angry/Frightened predictions can still confirm only their configured emergency keyword pairings, and only within the existing five-second window. **Fire** continues to use its separate detector-confirmed visual fire validation.
- The independent geometry-corroboration path remains restricted to repeated geometrically supported raw **Sad** observations. It cannot turn raw Surprised into Frightened.

This fixes **known label conflation**, not imperfect underlying expression classification. A future raw `fearful` misclassification could still occur: evaluate that separately using labeled, consented clips and confusion matrices. Facial expressions alone do not prove somebody's actual emotional state.

## Reproduce and validate

From Windows PowerShell:

```powershell
git pull --ff-only origin experiment/deepfilternet-sherpa-kws-20261028
npm.cmd test -- src/test/multimodalDistress.test.ts src/test/emotionEvents.test.ts
npm.cmd run build
```

Restart Electron to load the updated frontend. The tests assert that **Surprised 60% + "emergency"** does not verify distress, while a genuine `fearful` reading and the same accepted keyword still can. They also cover surprise/shock aliases and all configured facial-validation keywords.

For live testing, speak one enrolled accepted keyword (such as `help` or `emergency`) and deliberately show a surprised expression in a controlled test. Event History may record **Surprised**, but the five-second facial check should continue waiting for **Angry/Frightened** as applicable and then reject if no qualifying face appears. Check the *new* timestamp and final `alertValidation`; an older already saved alert will remain in history as originally recorded and is not silently rewritten.

Run this as a research experiment with downstream emergency notifications disabled until real noisy/surprise/fear cases have been measured.
