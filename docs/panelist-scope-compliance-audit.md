# Panelist Scope/SOP Compliance Audit

Branch: `panelist-scope-compliance`

Source reviewed: *Chapter-1-3-Updated-UPDATED-Ver1.1.1.1.2.docx* and the panelist notes supplied on 2026-10-08.

## Implemented in this branch

- Align the runtime attention formula with Chapter III: `0.4 visual + 0.3 audio + 0.3 object relevance`.
- Use configured priority objects for `Oweight(t)` instead of the strongest arbitrary COCO detection.
- Feed real CCTV microphone VAD RMS into the normalized audio contribution.
- Expose Sobel, Laplacian, and Motion as selectable saliency modes.
- Add the default unified attention threshold of 15/100 without treating saliency alone as an emergency.
- Add a validation layer for low visibility, unavailable/not-ready audio, high latency, and usable semantic object evidence.
- Show validation/fusion diagnostics in the live camera UI.
- Add validated motion-anomaly detection for person collapse, falling objects, and persistent rapid motion.
- Store motion anomalies as alert events and include them in emergency clip handling.
- Stabilize facial-expression output by averaging expression probabilities over three valid face frames.
- Correct YAMNet class indices to the official 521-class map.
- Add YAMNet fire, crackle, smoke-alarm, and fire-alarm cues for local-microphone scenarios.
- Add realistic-condition unit/scenario tests for degraded lighting, missing modalities, distress fusion, and fire corroboration.
- Enforce the manuscript's English-only speech scope in the production KWS runtime.
- Preserve the former Tagalog KWS/product behavior on the separate `tagalog-kws-experimental` branch.
- Replace the active Tagalog cues with English emergency keywords: `help`, `fire`, `emergency`, `danger`, `intruder`, `police`, `ambulance`, and `stop`.
- Add an offline automatic WAV-dataset trainer that normalizes real recordings, extracts runtime log-Mel features, caps outliers, recalibrates margins, and runs leave-one-out validation.
- Reject enrollment of out-of-scope keywords on this branch and ignore old Tagalog template folders if they remain on disk.
- Expose `POST /kws/auto-train` plus `python local-server/train_english_kws.py` for repeatable English KWS training.

## Already implemented before this branch; intentionally skipped

- CCTV/IP-camera Connect/Reconnect/Disconnect flow, RTSP discovery, saved reconnect intent, and backend health polling.
- COCO-SSD with MobileNetV2 object detection.
- Grayscale Sobel/Laplacian/motion saliency implementation.
- Visual fire/smoke/visibility detector with screen-content suppression and moving orange-clothing suppression.
- Same-camera Angry/Frightened + accepted help/emergency/scream distress fusion.
- Fire + smoke/low-visibility and visual-fire + accepted English `fire` verification.
- Alert snapshots, event history, bounded 50-entry history, clips, cooldowns, email/cloud logging.
- Custom trained CCTV keyword engine with open-set UNKNOWN validation; Whisper is disabled in the active runtime.

## Requirements that are research/evaluation work, not safe to fabricate in code

- SOP metrics such as confusion matrix, accuracy, latency, and robustness require labelled test cases/ground truth. Runtime latency is already measured, but accuracy/robustness must be calculated from the researchers' controlled scenario dataset.
- The thesis respondent plan specifies 20 home owners and 6 IT experts/professionals (26 total). This is a participant recruitment/evaluation requirement, not a software feature.
- IT experts must meet the experience/recency criteria stated in Chapter III.

## Thesis contradictions that require a document/product decision

1. **Language — resolved in software:** `panelist-scope-compliance` follows the manuscript's English-only scope. The prior Tagalog implementation remains available on `tagalog-kws-experimental` and is not active in this branch.
2. **Fire audio:** One scope section describes visual fire cross-checked with crackling/popping audio and realistic scenarios include audio-only fire cues; a later limitation says fire detection is strictly visual. The software now supports fire-related audio on the local-microphone path, but the thesis wording should be reconciled.
3. **Speech emotion implementation:** Scope/Research Design refers to MFCC/prosodic speech-emotion classification across eight classes, while Chapter III's concrete audio algorithm specifies RMS/FFT event analysis and the current CCTV path uses trained log-Mel/DTW keyword spotting plus face expressions. A genuinely trained MFCC eight-class speech-emotion classifier requires a labelled dataset/model and should not be represented as implemented until it exists and is validated.

## English KWS training status

The automatic trainer is implemented, but no speech dataset is fabricated or bundled. Real labelled WAV recordings from realistic household/CCTV conditions still have to be collected. The trainer reports `production_ready: true` only when every active English keyword has enough templates, every positive class passes leave-one-out calibration, and the UNKNOWN class has enough negative examples.

## Required empirical validation before panel presentation

Test real household scenes under normal light, low light, backlighting, fan/appliance noise, overlapping speech, different speaker distances/accents, camera angle changes, display-screen fire videos, orange/red clothing, real/safe fire imagery, smoke/visibility changes, normal movement, rapid movement, simulated fall posture, disconnected microphone, disconnected camera, and network/processing delay. Record expected vs observed class and latency for every trial so Chapter III accuracy/confusion-matrix/robustness results are evidence-based.
