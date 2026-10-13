# Train on the user-uploaded FER2013 archive.zip (no Kaggle 403)

This branch supports the image-folder ZIP the user provided to ChatGPT.
It is *not* the original `fer2013.csv` download, so the prior Kaggle
competition downloader is not applicable.

Verified uploaded file: `archive.zip` with 35,887 JPEGs (48×48 grayscale),
in `train/{angry,disgust,fear,happy,sad,surprise,neutral}` and
`test/{...}` with `PublicTest`/`PrivateTest` filename prefixes.

## Dataset validation and cleanup

The importer maps `fear→fearful`, `surprise→surprised`,
`disgust→disgusted`, and preserves:
`Training→train`, `PublicTest→val`, `PrivateTest→test`.
It checks the actual images and removes identical files across splits,
then excludes images with irreconcilably conflicting emotion labels.
Prefer keeping an exact image in `test`, then `val`, then `train`.
No participant-identity splits or perceptual similarity removal is assumed.

Observed actual image totals after cleaning the supplied archive:

| Split | Before | After |
| --- | ---: | ---: |
| Train | 28,709 | 26,912 |
| Validation (PublicTest) | 3,589 | 3,508 |
| Test (PrivateTest) | 3,589 | 3,557 |
| **Total** | **35,887** | **33,977** |

The uploaded archive contained 1,853 additional files with identical JPEG
bytes across the dataset, plus 57 groups with conflicting labels.
A total of 1,910 images were removed, including all members of the 57
conflicting-label groups. Dataset duplication remains possible at the
near-duplicate or same-person level.

## 1. Pull the new GitHub branch

From the repository root:

```powershell
git fetch origin
git switch feature/fer2013-uploaded-archive-20261014
git pull --ff-only origin feature/fer2013-uploaded-archive-20261014

cd training\facial_distress
& ".\.venv\Scripts\python.exe" -m pip install -r requirements.txt
```

If the `.venv` doesn't exist yet, run `py -m venv .venv` first.

## 2. Find your local copy of archive.zip

Use the ZIP you downloaded from Kaggle and uploaded to the ChatGPT
conversation. No Kaggle API credentials or competition download are
needed for this file.

```powershell
Test-Path "$HOME\Downloads\archive.zip"
```

If this is `False`, use the actual file path displayed in File Explorer.
If you downloaded the cleaned ZIP back from ChatGPT, it can be passed
instead of the original. Do not replace the ZIP with the research model.

## 3. Supabase access (only when choosing --upload)

The existing `msds-emotion-training` Storage bucket is private.
The local dataset uploader stores a cleaned FER2013 image ZIP as
several four-megabyte objects and verifies their SHA-256 hashes.
Supabase Storage **does not train models**; all training happens locally.

```powershell
$env:SUPABASE_URL="https://czdlvkthssvocicmidzj.supabase.co"
$secret=Read-Host "Supabase server secret key" -AsSecureString
$env:SUPABASE_SECRET_KEY=[System.Net.NetworkCredential]::new("",$secret).Password
```

Never share the key in chat, commit it, put it in the frontend, or
use a publishable/anon key. Review the FER2013 dataset terms before
uploading this image dataset into a private cloud bucket.

## 4. Import, upload and train

Substitute the actual path to your downloaded ZIP:

```powershell
& ".\.venv\Scripts\python.exe" run_fer2013.py `
  --image-archive "$HOME\Downloads\archive.zip" `
  --accept-kaggle-terms `
  --upload `
  --train `
  --epochs 12 `
  --batch-size 8
```

The **new --image-archive** route avoids the Kaggle API `403 Forbidden`
because it uses an existing local archive rather than downloading
FER2013 again. The route:

1. Verifies the ZIP and all 48×48 JPEG images.
2. Safely de-duplicates and creates `data/fer2013_cleaned/`.
3. Creates `data/fer2013_cleaned.zip`, with a JSON manifest.
4. With `--upload`, sends the cleaned ZIP to private Supabase
   Storage in integrity-checked four-megabyte shards.
5. With `--train`, fine-tunes MobileNetV3 (ImageNet-pretrained)
   on the cleaned train set and evaluates on held-out val/test.

If your GTX 1650 shows CUDA out of memory, reduce `--batch-size` to 4.
If `torch.cuda.is_available()` is False, training uses CPU and may
take considerably longer. Installing the appropriate CUDA-enabled
PyTorch build is a separate step.

If you only want to check and prepare the dataset:

```powershell
& ".\.venv\Scripts\python.exe" run_fer2013.py `
  --image-archive "$HOME\Downloads\archive.zip" `
  --accept-kaggle-terms
```

## 5. What the ChatGPT execution environment actually trained

A separate **compact CPU-only CNN research pilot** was successfully
trained from scratch for five epochs on all 26,912 cleaned training
images and evaluated on the 3,557-image test split:

- Held-out test accuracy: **54.96%**
- Held-out test macro-F1: **50.77%**
- Fearful-class recall: **22.5%**

The pilot can be downloaded from the conversation as
`FER2013_cpu_pilot_bundle.zip`. The pilot is **not** the MobileNetV3
implementation in this repository and is **not deployed**. Its
fearful-class recall is inadequate for emergency decisions.
Any new MobileNetV3 model must be evaluated independently on consented,
person-disjoint CCTV video under actual indoor lighting conditions.

The live SentryVision emotion detector remains unchanged and its
distress alerts retain the original safety-fusion requirements.
