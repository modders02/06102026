# Seven-expression recognition: training and evaluation

This opt-in training workflow is **not** an automatic internet image scraper,
a face identifier or a production emergency detector. It supports local,
authorized FER2013 photographs and consented personal photographs. Files stay
on the training PC and are gitignored.

## Current camera model and label correction

MSDS currently uses the pretrained `@vladmandic/face-api` expression detector
in `src/hooks/useFaceDistress.ts`. Its native classes are:

| Native class | Display name | Validates HELP face fusion? |
| --- | --- | --- |
| happy | Happy | No |
| sad | Sad | No |
| angry | Angry | Yes, with accepted HELP |
| fearful | Frightened | Yes, with accepted HELP |
| surprised | Surprised | **No**; shock is not necessarily fear |
| neutral | Neutral | No |
| disgusted | Disgust | No |

This branch **fixes the surprised -> frightened false-equivalence** in
informational emotion history and in safety fusion. It does not replace the
existing face-api weights or claim an accuracy increase before evaluation.
Facial expression is only an external appearance cue, not proof of true emotion.

## 1. Prepare a dedicated Python environment

Open PowerShell from the repo root:

```powershell
cd training\facial_distress
py -m venv .venv
& ".\.venv\Scripts\python.exe" -m pip install -r requirements.txt
```

Install the appropriate CUDA-enabled PyTorch wheel for the GTX 1650 only if
your Windows/Python setup supports it. Check the GPU:

```powershell
& ".\.venv\Scripts\python.exe" -c "import torch; print('CUDA:', torch.cuda.is_available())"
```

## 2. Obtain authorized research photographs

Dataset: official [FER2013 Kaggle competition](https://www.kaggle.com/c/challenges-in-representation-learning-facial-expression-recognition-challenge/data).

The images are **not** part of Microsoft's [FER+ annotations](https://github.com/microsoft/FERPlus):
original FER2013 images require a separate download. Review and comply with
Kaggle's terms and the dataset's permissions before using. The script does
not automatically scrape random faces from search engines or download
unlicensed photographs.

Place the authorized `fer2013.csv` somewhere on your local PC, then run
from `training\facial_distress`:

```powershell
& ".\.venv\Scripts\python.exe" import_fer2013.py --csv "D:\Downloads\fer2013.csv" --rights-checked
```

The importer produces `data/expressions/{train,val,test}/{angry,disgusted,
fearful,happy,sad,surprised,neutral}`. It preserves FER's
Training/PublicTest/PrivateTest boundaries, rejects bad images, and prevents
exact pixel duplicates between classes/splits. A tiny dry-run can use
`--limit-per-class 10`, but that is insufficient for model training.

This split is **not identity-separated** because FER2013 lacks reliable
subject IDs. Before thesis claims, obtain an additional independent,
person-disjoint consenting CCTV test cohort. Never treat validation/test
images as training photos.

## 3. Add your own pictures locally (optional)

Capture clearly labeled expressions of consenting adults, preferably
several takes under varied lighting. **Only use pictures of people who
have explicitly consented to this project and storage.** Example:

```powershell
& ".\.venv\Scripts\python.exe" import_own_photos.py --file "D:\Photos\help_face_01.jpg" --label fearful --subject-id participant-01 --consent-confirmed
& ".\.venv\Scripts\python.exe" import_own_photos.py --folder "D:\Photos\happy" --label happy --subject-id participant-01 --consent-confirmed
```

Choose one label from `angry, disgusted, fearful, happy, sad, surprised,
neutral`. The script finds **exactly one face**, crops it to 224x224,
removes background context and hashes the supplied subject pseudonym in
filenames. Photos with no or multiple faces are skipped. All resulting
files are added to **train only**; validation/test examples are never
replaced with personal photos from the same capture.

The `--subject-id` is a dataset grouping pseudonym, not biometric
identification. A local folder still contains sensitive face images:
keep it access-controlled, document participant consent, and delete
samples on withdrawal. Do not upload training data or saved models to
GitHub, Supabase, telemetry or public file sharing.

For quick demonstrations with one volunteer, use these pictures only for
a pilot. Never score that same volunteer's near-duplicate images as unseen
validation evidence.

## 4. Train an isolated 7-class model

```powershell
& ".\.venv\Scripts\python.exe" train_expressions.py --epochs 20 --batch-size 32
```

ImageNet-pretrained MobileNetV3-Small fine-tunes seven labels using
augmentation, balanced loss, early stopping and CUDA if available.
The script requires **at least 30 training, 10 validation and 10 test
photos per label**, and reports per-class precision, recall, F1,
confusion matrices and macro F1 on held-out FER2013 tests.

Outputs:

```text
artifacts/expressions/expression_candidate.pt
artifacts/expressions/expression_candidate.onnx
artifacts/expressions/expression_metrics.json
```

**Important:** These artifacts are experimental and **not automatically
installed into MSDS**. The live UI still runs pretrained face-api.
The previous `train.py` for normal/mild/severe remains intact and
separate. A custom model cannot be relied on until it has been integrated
into the runtime with validated preprocessing, inference, and fallback
tests. No claim of successful re-training is made merely by adding code.

## 5. Evaluate before replacing the current model

Verify all seven classes, notably `fearful` versus `surprised` and
`angry` versus `neutral`. Conduct separate tests on different consented
participants with actual CCTV footage, not just high-resolution portraits.
Measure macro-F1, class-wise confusion, false HELP+face alerts, lighting,
latency and group-level performance. If the model regresses or has
unacceptable false positives, **keep the current pretrained detector**.

The project remains experimental. An expression classification (including
a high confidence score) cannot establish a person's internal emotional
state, and a single facial expression does not authorize a safety alert.

## 6. Tests

```powershell
& ".\.venv\Scripts\python.exe" -m unittest discover -s tests -p "test_*.py" -v
```

Run frontend regression tests separately from repo root:

```powershell
npm.cmd test -- --run src/test/emotionEvents.test.ts src/test/multimodalDistress.test.ts
```

Data/model provenance:

- Microsoft FER+: https://github.com/microsoft/FERPlus
- Official FER2013: https://www.kaggle.com/c/challenges-in-representation-learning-facial-expression-recognition-challenge/data
- No copyrighted internet image scraping; any additional public datasets
  require independent review of license and permitted application.
