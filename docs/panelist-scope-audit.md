# Panelist Scope Compliance Audit

Branch: `panelist-scope-validation`

This audit compares the implemented system against the thesis Statement of the Problem,
Scope and Limitation, and the panelist comments received on 2026-10-08.

## Implemented and retained

- Real-time grayscale saliency processing with Sobel, Laplacian, and motion modes.
- COCO-SSD MobileNetV2 object detection with confidence filtering.
- Indoor priority-object selection.
- Visual fire analysis using fire color, temporal flicker, smoke/visibility context,
  display-screen suppression, and moving-clothing suppression.
- Facial expression analysis, with surprised/fear/shock-like states normalized to
  Frightened and Angry/Frightened used only as one half of verified distress fusion.
- Trained custom CCTV keyword spotting with open-set UNKNOWN rejection.
- Same-camera temporal fusion for Angry/Frightened + help/tulong/scream.
- Fire + safety-speech fusion, snapshots, clips, local history, cloud alert logging, and email.
- Runtime latency/FPS monitoring and adaptive throttling.
- Camera connection persistence and automatic reconnect.

## Changes made for the panelist review

1. Added an explicit final safety-event validation layer before notification/email/cloud
   dispatch. It rejects malformed, under-confident, or uncorroborated critical events.
2. Centralized the thesis multimodal attention weights at:
   - visual saliency = 0.40
   - audio importance = 0.30
   - semantic object relevance = 0.30
3. Replaced the old max-object-confidence fusion term with the thesis-style weighted
   semantic object importance score: sum(confidence * priority).
4. Fixed the Connect panel's Audio Detection status. The project is custom-KWS-only,
   so the panel no longer checks the disabled Whisper compatibility flag.
5. Corrected Expert Mode so it no longer claims that Whisper is the active CCTV engine.
6. Added regression tests for the attention formula, semantic object weighting, and
   final validation gate.

## Scope items that are not honestly implemented yet

These should not be claimed as completed in the final manuscript until they are either
implemented and validated or the manuscript is revised.

### 1. Eight-class MFCC speech-emotion recognition

The thesis Scope states that speech emotion is classified from pitch, intensity, tempo,
and MFCCs into anger, calm, disgust, fear, happiness, sadness, surprise, and neutral.

The current product has:
- face-expression classification;
- custom safety-keyword spotting;
- scream/distress-sound analysis;
- basic FFT/RMS/pitch analysis for a local microphone.

It does **not** contain a trained eight-class MFCC speech-emotion model. Implementing
a fake rule-based labeler would not satisfy research validity. A trained model, its dataset,
hold-out evaluation, confusion matrix, and deployment weights are still required.

### 2. Audio-only fire sound recognition

The Scope includes smoke-alarm, crackling, and popping examples in cases where video is
poor or absent. The current CCTV backend detects speech keywords and a conservative
scream candidate, but it does not yet contain a validated fire-sound classifier. Do not
claim audio-only fire detection until a fire-sound model/dataset is added and tested against
ordinary household sounds such as cooking, plastic bags, television audio, fans, and dishes.

### 3. Explicit fall / collapsing classifier

The saliency module detects strong motion/scene change, but it does not prove that a
person collapsed or that a specific object fell. High saliency is therefore treated as an
environmental anomaly rather than a medically meaningful fall detector. A real fall claim
requires temporal person pose/tracking or a validated fall-detection model.

### 4. Language-scope conflict

The thesis currently says English-only and explicitly places Filipino/Tagalog outside the
scope, while the running product intentionally supports trained `tulong` and `sunog`
keywords. This is a manuscript/system contradiction. For final defense, choose one:

- revise the thesis scope to explicitly include the limited trained Filipino safety keywords; or
- remove/disable those keywords and test English-only operation.

The code was **not** changed to remove `tulong`/`sunog` because they are active
system requirements in the current build.

## Required realistic validation matrix

At minimum, run and record ground truth, prediction, confidence, latency, and false
positive/negative outcome for:

| Scenario | Expected validation |
| --- | --- |
| Clear room + normal speech | No emergency |
| Fan/appliance noise + normal speech | No emergency |
| TV/phone displaying fire | Suppressed |
| Orange/red clothing moving | Suppressed |
| Real visible fire, no audio | Fire alert |
| Fire candidate + smoke/visibility degradation | Fire alert |
| Angry + accepted help | Verified distress |
| Frightened + accepted help | Verified distress |
| Angry/Frightened + scream | Verified distress |
| Neutral/sad + help | No multimodal distress alert |
| Rejected KWS candidate | No alert/database notification |
| Low light + ordinary household noise | No false fire |
| Sudden lighting/shadow change | No critical hazard unless corroborated |
| Camera disconnected/reconnected | Connection state recovers without duplicate camera processes |

For every scenario collect TP, TN, FP, FN, processing latency, and environment notes.
Aggregate results into confusion matrix, accuracy, precision, recall, F1, mean latency,
and a documented robustness score.

## Respondent requirement from Chapter III

The manuscript specifies 20 homeowners and 6 IT experts/professionals, total 26
respondents. The expert criteria state at least five years of relevant experience and
activity within two years of the thesis proposal. This is a research-procedure requirement,
not an application feature, so no source-code change is required.
