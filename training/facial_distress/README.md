# Custom Facial Distress Training

This workspace trains a **research classifier** for three labels:

- `normal`
- `mild_distress`
- `severe_distress`

The classifier is not an emergency detector by itself. Its output must remain a
candidate signal that the MSDS validation layer corroborates with speech,
sound, fire/smoke, and temporal persistence.

## 1. Create an isolated Python environment

From the repository root in PowerShell:

```powershell
cd training\facial_distress
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
```

For NVIDIA CUDA training, install the PyTorch build recommended for your
installed driver/CUDA environment from pytorch.org instead of relying on the
generic CPU wheel.

Check:

```powershell
python -c "import torch; print('CUDA:', torch.cuda.is_available()); print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU')"
```

## 2. Start the MSDS camera

The local camera server must be running and the camera should be connected as
`slot-1` (or pass another slot ID).

From a separate VS Code terminal at the repository root:

```powershell
npm.cmd run electron:dev
```

## 3. Capture labeled samples

Capture one class at a time:

```powershell
cd training\facial_distress
.\.venv\Scripts\Activate.ps1

python capture.py --camera slot-1 --label normal --count 200
python capture.py --camera slot-1 --label mild_distress --count 200
python capture.py --camera slot-1 --label severe_distress --count 200
```

The files are stored under:

```text
data/raw/
├── normal/
├── mild_distress/
└── severe_distress/
```

Collect data from multiple participants where permitted by your research
protocol. Include different distances, head angles, illumination, and
backgrounds. Do not put frames from the same near-identical sequence into
different labels.

### Suggested labeling protocol

**normal**
- neutral/resting
- reading or concentrating
- talking normally
- looking at a laptop/phone
- normal head turns

**mild_distress**
- concerned/worried pose
- mild discomfort
- moderate tension

**severe_distress**
- acted urgent distress
- clearly frightened/panicked pose
- strong distress expression

These are operational study labels, not diagnoses of a person's internal
emotional state.

For a thesis-quality dataset, aim for substantially more than the minimum 20
images per class. A useful first pilot is 200-500 face crops per class across
several participants.

## 4. Train

```powershell
python train.py --epochs 20 --batch-size 32
```

Training automatically uses CUDA when PyTorch can access the GPU.

Outputs:

```text
artifacts/
├── facial_distress_mobilenetv3.pt
├── facial_distress_mobilenetv3.onnx
├── metrics.json
└── confusion_matrix.png
```

## 5. Evaluate before integration

Review `metrics.json` and `confusion_matrix.png`. Do not integrate the model
only because overall accuracy is high. Check each class's precision, recall,
and F1 score, especially false `severe_distress` predictions from normal
faces.

A practical research target should be defined before final testing. Keep the
test set untouched while tuning the model.

## 6. Integration stage

After the model is validated, the next step is to replace or supplement the
current generic face-expression score with
`facial_distress_mobilenetv3.onnx`.

The runtime flow should remain:

```text
face crop
  -> custom classifier
  -> temporal persistence
  -> validation layer
  -> multimodal corroboration
  -> emergency decision
```

Never let a single facial frame independently trigger the emergency popup.
