# Supabase private emotion dataset: upload and train locally

Supabase project: `czdlvkthssvocicmidzj`. Private Storage bucket:
`msds-emotion-training`. The bucket exists, but **no image files have
been uploaded and no new model has been trained** yet.

Only use accurately labeled, authorized FER2013 or consented participant
photos. The example face portraits displayed in chat are not usable labeled
image assets. Do not scrape indiscriminately from image search or claim
synthetic faces are independent evidence of CCTV recognition accuracy.

## 1. Prepare your local dataset

Follow `EXPRESSION-TRAINING.md` and import authorized FER2013 imagery,
then optionally consented user photos. The seven native expression labels
are `angry, disgusted, fearful, happy, sad, surprised, neutral`; validation
and test splits must remain held out.

## 2. Connect private Supabase bucket (PowerShell)

From `training\\facial_distress`:

```powershell
& ".\\.venv\\Scripts\\python.exe" -m pip install -r requirements.txt
$env:SUPABASE_URL="https://czdlvkthssvocicmidzj.supabase.co"
$env:SUPABASE_SECRET_KEY=Read-Host "Supabase server secret key"
& ".\\.venv\\Scripts\\python.exe" sync_supabase.py upload --root data/expressions --prefix research-v1 --confirm-authorized-images
```

Retrieve the server secret in the Supabase dashboard **API Keys** settings;
never paste it into ChatGPT, GitHub, Electron/frontend code or a screenshot.
It grants privileged storage access. The upload script accesses only the
`msds-emotion-training` bucket, and paths are prefixed for isolation.

For a second trusted training PC:

```powershell
& ".\\.venv\\Scripts\\python.exe" sync_supabase.py download --root data/expressions --prefix research-v1 --confirm-authorized-images
```

## 3. Train only on a PC with permission to use the images

```powershell
& ".\\.venv\\Scripts\\python.exe" train_expressions.py --epochs 20 --batch-size 32
```

Inspect the per-class validation/test metrics in
`artifacts/expressions/expression_metrics.json`. The candidate remains
offline until held-out CCTV testing justifies integrating it.
Uploading files to Supabase **does not train a model automatically**.
Cloud GPU training is not configured by this branch.

## Access controls

The bucket is private. Authenticated upload/read/delete rules are
restricted to the authenticated user's UID first folder. These
rules do not grant public/anonymous access. The local synchronization
script uses a privileged **server-side** secret; never expose it in a
client application. Participant consent, deletion and retention
procedures are required before collecting real faces.
