# Realistic Indoor Validation Matrix

Use this sheet during controlled household testing. Record one row per trial, not one row per participant. The **Expected** column is the ground truth used later for the confusion matrix.

| ID | Environment / stimulus | Expected system result | Ground-truth class | Observed result | Correct? | Latency ms | Notes |
|---|---|---|---|---|---|---:|---|
| V01 | Normal light, empty room, ordinary ambient noise | No hazard alert | negative | | | | |
| V02 | Sudden single light switch / exposure change | Saliency may rise; no hazard alert | negative | | | | |
| V03 | Low light, no hazard, microphone connected | Degraded/low-light validation; no hazard alert | negative | | | | |
| V04 | Camera temporarily unavailable, clear microphone | Audio remains usable; visual marked unavailable | degraded | | | | |
| V05 | Microphone unavailable, clear camera | Visual/object/fire path remains usable; audio marked unavailable | degraded | | | | |
| O01 | Person enters room | Informational person/object event only | object | | | | |
| O02 | Priority household object appears | Object relevance contributes to attention; not automatically emergency | object | | | | |
| M01 | Normal walking | No motion-anomaly alert | negative | | | | |
| M02 | One-frame camera shake / light flash | No rapid-motion alert | negative | | | | |
| M03 | Persistent rapid unexplained movement | Motion-anomaly alert | motion-anomaly | | | | |
| M04 | Simulated upright-to-fallen person posture | Possible person collapse alert | motion-anomaly | | | | |
| M05 | Tracked household object falls downward | Possible falling-object alert | motion-anomaly | | | | |
| F01 | Orange/red shirt moving in front of camera | No fire alert | negative | | | | |
| F02 | Fire video displayed on TV/phone/laptop | No fire alert | negative | | | | |
| F03 | Visual flame-like region without corroboration | Candidate only unless visual detector reaches independent fire criteria | fire-candidate | | | | |
| F04 | Visual fire + temporal smoke region | Critical fire alert | fire | | | | |
| F05 | Visual fire + low visibility/smoke obstruction | Critical fire alert | fire | | | | |
| F06 | Accepted "sunog" with no visual fire | No fire alert | negative | | | | |
| F07 | Visual fire + accepted "sunog" within fusion window | Critical verified-fire alert | fire | | | | |
| A01 | Ordinary conversation | No distress alert | negative | | | | |
| A02 | Fan/appliance noise only | No distress alert | negative | | | | |
| A03 | Smoke-detector/fire-alarm sound on local microphone | Fire-related sound alert | fire-audio | | | | |
| A04 | Strong fire/crackle sound on local microphone | High fire-related sound alert | fire-audio | | | | |
| D01 | Neutral/happy face + accepted "help" | No multimodal distress alert | negative | | | | |
| D02 | Sad face + accepted "help" | No multimodal distress alert | negative | | | | |
| D03 | Angry face + accepted "help" within 10 s | Critical verified distress alert | distress | | | | |
| D04 | Frightened face + accepted "help" within 10 s | Critical verified distress alert | distress | | | | |
| D05 | Frightened face + accepted "tulong" within 10 s | Critical verified distress alert (only if Tagalog remains in approved scope) | distress | | | | |
| D06 | Frightened face + scream within 10 s | Critical verified distress alert | distress | | | | |
| D07 | One unstable Frightened face frame followed by neutral frames | Facial smoothing should reduce flicker; no face-only alert | negative | | | | |
| K01 | Rejected KWS candidate below threshold | Diagnostic candidate only; no alert/database notification | negative | | | | |
| K02 | KWS candidate too close to UNKNOWN | Reject; no alert | negative | | | | |
| K03 | KWS candidate too close to another safety word | Reject as ambiguous; no wrong keyword alert | negative | | | | |
| P01 | Processing latency >1500 ms | Validation flags high latency | degraded | | | | |

## Minimum condition variations

Repeat safety-critical scenarios with:
- normal, dim, backlit, and rapidly changing light;
- quiet room, fan/air-conditioner noise, television noise, and overlapping speech;
- near, middle, and far speaker distance;
- at least several speakers with different pacing/accent;
- frontal, partial-profile, and moderate head-turn face angles;
- SD and HD camera modes;
- temporary camera/audio/network interruption.

## Metrics

For each target class, derive TP, FP, TN, and FN from the labelled rows. Report:

- Accuracy = (TP + TN) / total trials.
- Precision = TP / (TP + FP).
- Recall = TP / (TP + FN).
- F1 = 2 * precision * recall / (precision + recall).
- Mean and percentile latency from the recorded latency values.
- Robustness = performance retained across degraded-condition subsets (low light, noise, distance, interruption), reported explicitly with the chosen formula in the thesis.

Do not create final accuracy/confusion-matrix values before the controlled trials are actually performed.
