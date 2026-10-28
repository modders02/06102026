# MSDS neural voice experiment — automatic Windows setup (28 Oct 2026)

> **Recovery branch note (28 October 2026):** The previous aggressive default presets may lose quiet words. On `fix/kws-speech-preservation-diagnostics-20261028`, this launcher now starts with **DTW-only, standard noise filtering and normal hearing**, not neural shadow / maximum / far. See `docs/kws-audio-reliability-recovery-20261028.md` for the recommended first test and raw baseline.


Branch: `experiment/deepfilternet-sherpa-kws-20261028`  
Stable backup: `stable_branch_271026` (unchanged)

This is an opt-in **research comparison**, not a proven emergency alert
upgrade. The stable custom English Log-Mel/DTW model and enrollment samples
are preserved. A real CCTV evaluation is required before using neural
verification to gate emergency notifications.

## One-time download, installation, and launch

Requirements: **Windows 10/11**, working internet, Git, Node.js/npm,
Python 3 with venv/pip, and storage for PyTorch and the neural models.
Python packages must have compatible Windows wheels for your chosen
Python version. DeepFilterNet may fail on unsupported Python/Windows
configurations. The installer reports this rather than pretending the
new pipeline is working.

**DeepFilterLib 0.5.6 builds from Rust source on Windows.** When it is not
installed yet, the launcher now automatically:
1. Checks for Microsoft Visual Studio C++ Build Tools (MSVC plus Windows SDK).
2. If Build Tools 2022 is **already installed**, runs the Microsoft
   `setup.exe modify --installPath ... --add Microsoft.VisualStudio.Workload.VCTools
   --includeRecommended` operation. It deliberately **does not** issue
   `winget install`, which can attempt to upgrade an existing installation
   instead of adding the required workload. If Build Tools is not installed,
   downloads the officially signed Microsoft bootstrapper.
   This is a **large download**, can request Windows administrator approval,
   and sometimes requires a restart.
3. Downloads the official Rustup installer from `static.rust-lang.org`, then
   installs 64-bit stable Rust/Cargo using the Windows MSVC toolchain.
4. Makes Cargo available to pip in the SAME PowerShell process and retries
   the DeepFilterNet installation with a 120-second network timeout.

If Visual Studio's installer asks for permission, approve it only if you
want to install Microsoft's development tools on this PC. If the machine
lacks administrator privileges or compatible native extensions, do not
force deployment; use the unchanged DTW engine.

From PowerShell in your existing working repository:

```powershell
git fetch origin
git switch --track origin/experiment/deepfilternet-sherpa-kws-20261028
.\start-neural-kws.cmd
```

If already on this branch, use `git pull --ff-only` before running.

Double-clicking `start-neural-kws.cmd` in Explorer also works **after
checking out the experimental branch**. It downloads/installs what is
missing, verifies the models, and then starts `npm.cmd run electron:dev`
in the same process. The first launch needs internet; later launches
reuse the venv and already downloaded model files. To skip repeat Python
package installation:

```powershell
.\start-neural-kws.cmd -SkipInstall
```

To install and check models without launching Electron:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\local-server\setup-neural-kws.ps1 -NoLaunch
```

The script runs only after **you execute it on your PC**. No remote
installation, persistent Windows Startup task or service is created.

### Automatically installed resources

1. The project Python virtual environment and existing MSDS dependencies.
2. Matched **CPU torch 2.5.1 / torchaudio 2.5.1** wheels, DeepFilterNet,
   sherpa-onnx, SciPy, **SentencePiece** and **pypinyin**.
   The 2.5.1 pin is intentional: DeepFilterNet 0.5.6 still imports
   `torchaudio.backend.common.AudioMetaData`, which was removed in newer
   torchaudio releases. Both matching 2.5.1 Windows Python 3.12 CPU
   wheels are published by PyTorch.
   Sherpa-onnx's English
   BPE `text2token` helper imports both of the latter libraries, even
   when no Chinese words are being tokenized; both must be installed
   before generating keyword files.
3. Official **English** GigaSpeech Zipformer KWS model from
   `k2-fsa/sherpa-onnx` release `kws-models`:
   `sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01`.
4. A generated English BPE keyword file with the **seven** configured
   safety words: help, fire, emergency, danger, intruder, police, ambulance.
5. The pretrained DeepFilterNet3 model through its official Python
   initialization routine (on first use).
6. Existing Node packages, when `node_modules` is absent.

Model weights and downloaded archives are local and Git-ignored;
recorded audio and previously enrolled templates are never uploaded.

### Current processing design

```text
CCTV RTSP -> FFmpeg PCM16 / 16 kHz -> WebRTC VAD (optional)
    -> original segment + original Log-Mel/DTW KWS -> normal audio-visual validation
    -> experimental (separate thread):
         16k -> 48k -> DeepFilterNet3 -> 16k
         -> sherpa-onnx English KWS
         -> /status comparison diagnostics, NEVER an alert in SHADOW mode
```

**Important technical limitation:** DeepFilterNet3 currently processes
segments **after** VAD, not the continuous raw microphone feed. If VAD
misses a quiet word under loud noise, this experimental neural pipeline
cannot recover it. Neural KWS inference is serialized between cameras
and may be slower than DTW on low-end computers. This is not an
unqualified guarantee of 1-second audio recognition.

Modes (set through `MSDS_KWS_NEURAL_MODE`):

| Mode | DTW alerts | Neural computation | Intended use |
|---|---|---|---|
| `off` | unchanged | off | baseline |
| `shadow` | unchanged | background comparison | **default for one-click installer** |
| `verify` | DTW + neural same-word agreement required | blocking | experimental only; may **miss** genuine emergencies |

To start the strict experimental `verify` mode (not recommended until
measured results support it):

```powershell
.\start-neural-kws.cmd -SkipInstall -Mode verify
```

The installer explicitly turns off the old FFmpeg FFT denoise preset to
avoid double-filtering, enables WebRTC VAD, and disables the optional
90% HELP shortcut for a fair comparison. These are process-local
variables; they are not written into Windows permanent environment
variables.

### Confirm it actually works

In a second PowerShell terminal:

```powershell
$st = Invoke-RestMethod "http://127.0.0.1:5000/status"
$cam = $st.cameras | Where-Object id -eq "slot-1"
$cam.audio.custom_kws | Select-Object neural_mode,neural_candidate,neural_processing_ms,neural_last_error,neural_last_at,neural_denoised,neural_busy,vad_backend
```

Say a properly trained keyword clearly into the **CCTV microphone**
(not the PC mic), and inspect `neural_candidate` and
`neural_last_error`. If no new segment is detected, check VAD and
camera audio status. Neural `shadow` runs on recent DTW candidate
segments but does **not** recognize independently when the segmenter
produces no segment.

### Regression tests

```powershell
& ".\local-server\.venv\Scripts\python.exe" -m unittest discover -s ".\local-server\tests" -p "test_neural_kws_trial.py"
& ".\local-server\.venv\Scripts\python.exe" -m unittest discover -s ".\local-server\tests" -p "test_kws_*.py"
npm.cmd test -- --run
npm.cmd run build
```

Tests mock the neural models and do not establish real recognition
accuracy; both downloaded engines require live model preflight and
real recorded holdout evaluation.

### Troubleshooting

- **Cargo, the Rust package manager, is not installed**: The setup
  detects this and runs `ensure-neural-build-tools.ps1` automatically.
  Run `.\\start-neural-kws.cmd` again after updating the branch.
  To inspect the tools manually: `cargo --version` and `rustc --version`.
- **`unknown proxy name: msds-rustup-init`**: The previous setup
  renamed Rust's multi-call installer, so Rust was never installed.
  Update this branch and rerun `.\\start-neural-kws.cmd`. The corrected helper
  saves the official executable as
  `%TEMP%\\msds-neural-rustup\\rustup-init.exe` and invokes it by its
  expected filename. No Rust uninstall is required.
- **Visual Studio Build Tools 2022 is installed, but `winget` reports
  an upgrade/install error (exit 1)**: Update the branch. The repaired
  script uses `setup.exe modify` on the existing installation, not
  `winget install`. Do not uninstall Build Tools just to resolve this error.
- **Microsoft Visual Studio Build Tools or link.exe missing**: Open
  **Visual Studio Installer > Build Tools 2022 > Modify > Workloads >
  Desktop development with C++**. Ensure the MSVC x64/x86 compiler
  and Windows 10/11 SDK are selected, then click **Modify**. This is
  the manual fallback if the automatic modification returns exit 1.
  Restart Windows if prompted, then rerun the launcher.
  Administrator approval may be required.
- **pip network read timeout**: The setup now uses
  `--timeout 120 --retries 10` for downloading Python packages.
  Keep an internet connection and retry; already-installed PyTorch should
  not need to download again.
- **pip no matching distribution / DLL load failure**: Python version or
  CPU/Windows wheel incompatibility; use a supported interpreter or
  disable neural mode. Do not claim the model is installed.
- **Model download failed**: Check internet and the official GitHub
  release URL. Do not use arbitrary third-party executables.
- **`ModuleNotFoundError: No module named 'sentencepiece'`**: The original
  installer did not install the BPE tokenizer dependency. Update this branch
  and rerun `.\\start-neural-kws.cmd`. Already installed Rust, DeepFilterNet,
  sherpa-onnx, and the extracted GigaSpeech model are reused. To repair
  without repeating all installation checks, install the missing wheel in
  the *same* MSDS virtual environment first:
  `& ".\\local-server\\.venv\\Scripts\\python.exe" -m pip install sentencepiece`
  and then run `.\\start-neural-kws.cmd -SkipInstall`.
- **`ModuleNotFoundError: No module named 'pypinyin'`**: SentencePiece
  is already installed, but sherpa-onnx also imports pypinyin even for
  English BPE keyword token generation. Update this branch and rerun
  `.\\start-neural-kws.cmd`. As a direct recovery without repeating
  all package installation, use:
  `& ".\\local-server\\.venv\\Scripts\\python.exe" -m pip install pypinyin`
  followed by `.\\start-neural-kws.cmd -SkipInstall`.
  The generated tokens now include their explicit original-word labels,
  e.g. `@HELP`, which sherpa-onnx preserves.
- **`ModuleNotFoundError: No module named 'torchaudio.backend'`**:
  DeepFilterNet 0.5.6 imports the legacy torchaudio backend API, but
  the unpinned launcher previously installed newer torchaudio 2.11.0
  (and torch 2.14.1), which no longer supplies that module.
  Update this branch and run `.\\start-neural-kws.cmd` **without**
  `-SkipInstall`. The launcher installs the official, matching CPU
  `torch==2.5.1 torchaudio==2.5.1` builds and checks the old import
  before model initialization. This will replace the newer PyTorch
  packages in the *experimental* Python virtual environment and may
  download a large wheel. Do not attempt to mix incompatible versions.
- **DeepFilterNet `too many values to unpack` on model preflight**: The
  current Python `init_df()` returns four values, whereas older examples
  returned three. This branch now accepts both.
- **No `sherpa-onnx-cli.exe`**: Confirm the package installed in
  `local-server/.venv` and rerun the setup.
- **`neural_last_error`**: Neural worker failed. Shadow mode leaves
  DTW unchanged. Verify mode blocks the keyword rather than silently
  bypassing verification.
- **High CPU/lag**: Test with one camera first; stop the experiment
  and compare offline latency/recall/false acceptances.

## Restore stable behavior

Close Electron and restart with the stable branch:

```powershell
git switch stable_branch_271026
$env:MSDS_KWS_NEURAL_MODE = "off"
$env:MSDS_KWS_ROBUST_MODE = "off"
$env:MSDS_KWS_WEBRTC_VAD = "0"
$env:MSDS_KWS_AUDIO_DENOISE = "0"
npm.cmd run electron:dev
```

No trained .npy templates are migrated or deleted by this experiment.
