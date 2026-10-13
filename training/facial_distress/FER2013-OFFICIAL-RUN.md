# Run official FER2013: Kaggle → private Supabase → seven-class GPU model

**Actual dataset/model status:** The official FER2013 bytes have not been
downloaded in the ChatGPT execution environment because Kaggle's competition
download requires authenticated access. No images are currently uploaded to
Supabase and no new FER2013 model has been trained. This branch supplies an
authenticated and reproducible local workflow rather than inventing results.

The [official Kaggle challenge](https://www.kaggle.com/c/challenges-in-representation-learning-facial-expression-recognition-challenge/data)
contains 35,887 images split into 28,709 Training, 3,589 PublicTest,
and 3,589 PrivateTest; its license is subject to competition rules. Review
and accept these rules with your own Kaggle account before downloading.
No external face-image scraping or uncertain-license mirrors are used.

## 1. Pull the branch

From the existing repository root on your Windows PC:

```powershell
git fetch origin
git switch feature/fer2013-official-one-command-20261014
git pull --ff-only origin feature/fer2013-official-one-command-20261014
cd training\facial_distress
py -m venv .venv
& ".\.venv\Scripts\python.exe" -m pip install -r requirements.txt
```

There are two ways to provide Kaggle access. Choose one:

- **Manual Kaggle download:** Log in to the original Kaggle competition,
  accept its rules and download `fer2013.tar.gz` (or the official ZIP).
  Pass it as `--archive "D:\Downloads\fer2013.tar.gz"`.
  This does *not* require configuring Kaggle CLI credentials.
- **Authenticated CLI:** Keep your Kaggle API credentials only on your
  own computer (for example, your local `~/.kaggle/kaggle.json`
  or the documented `KAGGLE_API_TOKEN` environment setting),
  then run without `--archive`. Never send credentials in chat or
  commit them to GitHub.

## 2. Set private Supabase access (optional cloud upload)

The MSDS Supabase private Storage bucket is `msds-emotion-training`.
The dataset is sharded into 4 MiB objects because this bucket currently
limits each object to 5 MiB. Compressed data shards are checked with
SHA-256, and the manifest is published only after all parts upload.

To upload from your PC, set two variables **in that PowerShell window**:

```powershell
$env:SUPABASE_URL="https://czdlvkthssvocicmidzj.supabase.co"
$env:SUPABASE_SECRET_KEY=Read-Host "Supabase server secret key (private)"
```

You can find your server-side secret in **Supabase Dashboard → Settings
→ API Keys**. This is a privileged server credential. Do not place it
in Electron, web code, GitHub, messages, screenshots or a training log.
If you don't want cloud uploads, omit `--upload`; local training still works.

## 3. Import + upload + train with one command

Using a downloaded official archive:

```powershell
& ".\.venv\Scripts\python.exe" run_fer2013.py --archive "D:\Downloads\fer2013.tar.gz" --accept-kaggle-terms --upload --train --epochs 12 --batch-size 16
```

If your Kaggle CLI is already logged in, omit `--archive`:

```powershell
& ".\.venv\Scripts\python.exe" run_fer2013.py --accept-kaggle-terms --upload --train --epochs 12 --batch-size 16
```

With no Supabase secret, omit `--upload`. On the Acer GTX 1650 4GB,
batch size 16 is a useful initial setting; reduce to `--batch-size 8`
if CUDA reports out of memory. Installation of the right CUDA-enabled
PyTorch package and compatible driver is required for GPU training;
otherwise PyTorch will use the CPU and be much slower.

The runner performs these steps in order:

1. Downloads **only official Kaggle** `fer2013.tar.gz`, unless a local
   archive is provided. Extracts **only** `fer2013.csv`.
2. Validates original `emotion,pixels,Usage` fields, seven labels,
   48×48 image dimensions, and the exact official split counts.
3. Converts images into separate `train/val/test` folders, omitting exact
   duplicate pixel images across classes/splits.
4. If requested, compresses and uploads the **source CSV** in small
   SHA-256-checked shards to your private Supabase bucket.
5. If requested, fine-tunes experimental MobileNetV3-Small with seven
   expression labels, weighted class loss, augmentation and held-out
   test metrics.

Raw images and checkpoints remain ignored by Git. The official FER2013
evaluation splits are preserved; they are not silently used for training.
Training may take significant time on a GTX 1650, depending on CUDA and disk.

## 4. Inspect model output

```text
training/facial_distress/artifacts/expressions/expression_candidate.pt
training/facial_distress/artifacts/expressions/expression_candidate.onnx
training/facial_distress/artifacts/expressions/expression_metrics.json
```

You can test a separate consented photo (one face):

```powershell
& ".\.venv\Scripts\python.exe" predict_expressions.py --image "D:\Photos\my_test_face.jpg"
```

The result is a **candidate seven-class expression classifier**.
It is not integrated into the live SentryVision/Electron camera and
cannot authorize emergency alerts by itself. In particular, SURPRISED
is not interchangeable with FEARFUL, and appearance is not proof of
an actual emotional state. The model needs person-disjoint, real-camera
evaluation and false-positive testing before deployment.

## 5. Restore FER2013 from private Supabase later

```powershell
& ".\.venv\Scripts\python.exe" sync_fer2013_bundle.py download --csv data/fer2013.csv --prefix research_v1 --confirm-kaggle-terms
```

A private encrypted transport does not change the underlying dataset's
reuse/license restrictions. Only authorized researchers should have
access to this storage.

## 6. Run offline regression tests

```powershell
& ".\.venv\Scripts\python.exe" -m unittest discover -s tests -p "test_*.py" -v
```

Tests use mocked Kaggle archives and in-memory Supabase storage. They
do **not** require credentials or train on real FER2013 photos.
