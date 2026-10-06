/**
 * MSDS Electron — packaged local service supervisor (Windows-first).
 *
 * Starts the existing Python bridge (local-server/camera_server.py) which in
 * turn supervises MediaMTX + per-camera FFmpeg processes (msds/manager.py).
 * We deliberately never spawn ffmpeg/mediamtx ourselves — that would create
 * duplicate services fighting over ports 8554/8888.
 *
 * Packaged layout (electron-builder.yml extraResources):
 *   <resources>/local-server/camera_server.py
 *   <resources>/local-server/bin/{ffmpeg,ffprobe,mediamtx}.exe
 *   <resources>/local-server/mediamtx.yml
 *
 * Python runs the installed source with its working directory and virtualenv
 * under userData/camera-runtime. Installation resources stay read-only. Binary
 * discovery is pinned to the shipped binaries or writable first-run downloads.
 */
const { app } = require('electron');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const http = require('http');

const IS_WINDOWS = process.platform === 'win32';
const STATUS_URL = process.env.MSDS_CAMERA_SERVER_URL || 'http://127.0.0.1:5000';

/** @type {import('child_process').ChildProcess | null} */
let child = null;
let setupChild = null;
let finishSetup = null;
let stopping = false;
let childError = null;

/**
 * First-run bootstrap progress, surfaced to the renderer through main.cjs.
 * phase: idle | venv | deps | binaries | starting | ready | error | skipped
 */
let bootstrap = { phase: 'idle', message: '', firstRun: false };
const setPhase = (phase, message) => {
  bootstrap = { ...bootstrap, phase, message };
  log(`[${phase}] ${message}`);
};

const log = (...args) => console.log('[msds:local-server]', ...args);
const logErr = (...args) => console.error('[msds:local-server]', ...args);


/** Resolve the packaged (or repo) local-server directory. */
function localServerDir() {
  const candidates = [
    process.env.MSDS_LOCAL_SERVER_DIR,
    app.isPackaged ? path.join(process.resourcesPath, 'local-server') : null,
    path.join(__dirname, '..', 'local-server'),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'camera_server.py'))) return dir;
  }
  return null;
}

/** Find Python, preferring the managed environment after an explicit override. */
function resolvePython(runtimeDir) {
  const candidates = [];
  if (process.env.MSDS_PYTHON_EXE) candidates.push(process.env.MSDS_PYTHON_EXE);
  // Reuse the environment created in the writable runtime.
  candidates.push(
    IS_WINDOWS
      ? path.join(runtimeDir, '.venv', 'Scripts', 'python.exe')
      : path.join(runtimeDir, '.venv', 'bin', 'python')
  );
  for (const cand of candidates) {
    if (cand && fs.existsSync(cand)) return { exe: cand, args: [] };
  }
  // Fall back to a system interpreter on PATH.
  const probes = IS_WINDOWS
    ? [{ exe: 'py', args: ['-3'] }, { exe: 'python', args: [] }]
    : [{ exe: 'python3', args: [] }, { exe: 'python', args: [] }];
  for (const probe of probes) {
    try {
      const res = spawnSync(probe.exe, [...probe.args, '--version'], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 10000,
      });
      if (res.status === 0) return probe;
    } catch { /* keep probing */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// First-run bootstrap: virtualenv -> pip install -r requirements.txt -> binaries
// ---------------------------------------------------------------------------

const venvPython = (dir) =>
  IS_WINDOWS ? path.join(dir, '.venv', 'Scripts', 'python.exe') : path.join(dir, '.venv', 'bin', 'python');

/** Find any interpreter on PATH that can create a virtualenv. */
function systemPython() {
  if (process.env.MSDS_PYTHON_EXE && fs.existsSync(process.env.MSDS_PYTHON_EXE)) {
    return { exe: process.env.MSDS_PYTHON_EXE, args: [] };
  }
  const probes = IS_WINDOWS
    ? [{ exe: 'py', args: ['-3'] }, { exe: 'python', args: [] }]
    : [{ exe: 'python3', args: [] }, { exe: 'python', args: [] }];
  for (const probe of probes) {
    try {
      const res = spawnSync(probe.exe, [...probe.args, '--version'], { stdio: 'ignore', windowsHide: true, timeout: 10000 });
      if (res.status === 0) return probe;
    } catch { /* keep probing */ }
  }
  return null;
}

/** Keep the window and bootstrap-status IPC responsive during first-run setup. */
function run(exe, args, opts, timeoutMs = 15 * 60 * 1000) {
  if (stopping) return Promise.resolve(false);
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(exe, args, { stdio: 'inherit', windowsHide: true, ...opts });
    } catch (error) {
      logErr(error.message);
      resolve(false);
      return;
    }
    setupChild = proc;
    const timer = setTimeout(() => { killProcessTree(proc); finish(false); }, timeoutMs);
    const finish = (ok) => {
      clearTimeout(timer);
      if (setupChild === proc) { setupChild = null; finishSetup = null; }
      resolve(ok);
    };
    finishSetup = finish;
    proc.once('error', (error) => { logErr(error.message); finish(false); });
    proc.once('close', (code) => finish(code === 0));
  });
}

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

/**
 * Make sure the bridge can actually run: a virtualenv exists, requirements are
 * installed (faster-whisper included) and ffmpeg/ffprobe/mediamtx are present.
 *
 * Everything is idempotent and guarded by a marker file, so only the very first
 * launch pays the download cost. Failures are non-fatal: we still try to start
 * the bridge with whatever is available and report the problem.
 */
async function bootstrapEnvironment(dir, runtimeDir = dir) {
  if (process.env.MSDS_SKIP_BOOTSTRAP === '1') {
    bootstrap = { phase: 'skipped', message: 'MSDS_SKIP_BOOTSTRAP=1', firstRun: false };
    return { ok: true, error: null };
  }

  const reqFile = path.join(dir, 'requirements.txt');
  const hasReq = fs.existsSync(reqFile);
  const marker = path.join(runtimeDir, '.venv', '.msds-deps');
  const requirementsHash = hasReq ? sha1(fs.readFileSync(reqFile, 'utf8')) : 'none';

  let py = venvPython(runtimeDir);
  const hadVenv = fs.existsSync(py);
  bootstrap.firstRun = !hadVenv;

  // 1) virtualenv
  if (!hadVenv && !process.env.MSDS_PYTHON_EXE) {
    const sys = systemPython();
    if (!sys) {
      const error = 'Python 3.10+ was not found. Install it from python.org (tick "Add python.exe to PATH") and restart the app.';
      bootstrap = { phase: 'error', message: error, firstRun: true };
      return { ok: false, error };
    }
    setPhase('venv', 'Creating the Python environment (first run, one time only)…');
    if (!await run(sys.exe, [...sys.args, '-m', 'venv', '.venv'], { cwd: runtimeDir }, 5 * 60 * 1000)) {
      logErr('venv creation failed — falling back to the system interpreter.');
    }
  }

  const useVenv = !process.env.MSDS_PYTHON_EXE && fs.existsSync(venvPython(runtimeDir));
  py = useVenv ? venvPython(runtimeDir) : null;
  const sys = py ? null : systemPython();
  if (!py && !sys) {
    const error = 'No usable Python interpreter found for dependency installation.';
    bootstrap = { phase: 'error', message: error, firstRun: bootstrap.firstRun };
    return { ok: false, error };
  }
  const pyExe = py ?? sys.exe;
  const pyArgs = py ? [] : sys.args;
  // Switching an explicit interpreter must install into that interpreter even
  // if the same requirements were already installed in the managed venv.
  const wanted = `${requirementsHash}:${sha1(JSON.stringify([pyExe, pyArgs]))}`;

  // 2) python dependencies (fastapi, uvicorn, faster-whisper, …)
  let installed = false;
  try { installed = fs.readFileSync(marker, 'utf8').trim() === wanted; } catch { installed = false; }
  if (!installed && hasReq) {
    setPhase('deps', 'Installing camera + Whisper dependencies (first run, this can take a few minutes)…');
    await run(pyExe, [...pyArgs, '-m', 'pip', 'install', '--upgrade', 'pip'], { cwd: runtimeDir }, 5 * 60 * 1000);
    const ok = await run(pyExe, [...pyArgs, '-m', 'pip', 'install', '-r', reqFile], { cwd: runtimeDir });
    if (ok) {
      try {
        fs.mkdirSync(path.dirname(marker), { recursive: true });
        fs.writeFileSync(marker, wanted);
      } catch { /* marker is an optimisation only */ }
    } else {
      logErr('pip install failed — CCTV audio (Whisper) may be unavailable.');
    }
  }

  // 3) ffmpeg / ffprobe / mediamtx
  const ext = IS_WINDOWS ? '.exe' : '';
  const needBinaries = ['ffmpeg', 'ffprobe', 'mediamtx']
    .some((n) => !fs.existsSync(path.join(dir, 'bin', n + ext)) &&
      !fs.existsSync(path.join(runtimeDir, 'bin', n + ext)));
  if (needBinaries && fs.existsSync(path.join(dir, 'fetch_binaries.py'))) {
    setPhase('binaries', 'Downloading FFmpeg and MediaMTX…');
    // The downloader derives bin/ from its own location. Give it a writable
    // copy, while keeping the installed source and shipped binaries untouched.
    const downloader = path.join(runtimeDir, 'fetch_binaries.py');
    if (runtimeDir !== dir) fs.copyFileSync(path.join(dir, 'fetch_binaries.py'), downloader);
    if (!await run(pyExe, [...pyArgs, downloader], { cwd: runtimeDir }, 10 * 60 * 1000)) {
      logErr('binary download failed — place ffmpeg/ffprobe/mediamtx in local-server/bin manually.');
    }
  }

  setPhase('starting', 'Starting the local camera bridge…');
  return { ok: true, error: null };
}

/** Current bootstrap phase (for the renderer). */
const getBootstrapStatus = () => ({ ...bootstrap });


/** Env for the child: pin the packaged binaries when they exist. */
function childEnv(dir, runtimeDir = dir) {
  const env = { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' };
  env.MSDS_RUNTIME_DIR = runtimeDir;
  const ext = IS_WINDOWS ? '.exe' : '';
  for (const [name, key] of [
    ['ffmpeg', 'FFMPEG_EXE'],
    ['ffprobe', 'FFPROBE_EXE'],
    ['mediamtx', 'MEDIAMTX_EXE'],
  ]) {
    const shipped = path.join(dir, 'bin', name + ext);
    const p = fs.existsSync(shipped) ? shipped : path.join(runtimeDir, 'bin', name + ext);
    if (fs.existsSync(p)) env[key] = p;
  }
  return env;
}

/** Require the camera bridge's status payload, not any service on port 5000. */
function probeStatus(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(`${STATUS_URL}/status`, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) { res.resume(); resolve(false); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (part) => {
        body += part;
        if (body.length > 1024 * 1024) { req.destroy(); resolve(false); }
      });
      res.on('end', () => {
        try {
          const status = JSON.parse(body);
          resolve(Array.isArray(status.cameras) && typeof status.mediamtx === 'boolean');
        } catch { resolve(false); }
      });
      res.on('error', () => resolve(false));
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

/** Poll /status until ready or the budget expires. Never blocks forever. */
async function waitForReady(totalMs = 30000, intervalMs = 1000) {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    if (await probeStatus()) return true;
    if (childError || !child || child.exitCode !== null) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/**
 * Should Electron own the local server?
 *  - packaged builds: yes
 *  - development: yes, unless MSDS_MANAGE_LOCAL_SERVER=0 opts out
 * An already-running bridge is reused rather than duplicated.
 */
function shouldManage() {
  // Auto-manage the local camera stack in BOTH development and packaged builds.
  // The startup path probes /status first, so an already-running manual bridge
  // is reused instead of creating a duplicate instance.
  //
  // Set MSDS_MANAGE_LOCAL_SERVER=0 only when you explicitly want to run
  // local-server\\start_server.bat yourself.
  if (process.env.MSDS_MANAGE_LOCAL_SERVER === '0') return false;
  return true;
}

/**
 * Start the bridge if needed. Returns a status object; never throws.
 * @returns {Promise<{managed:boolean, running:boolean, error:string|null, pythonPath?:string, dir?:string}>}
 */
async function startLocalServer() {
  stopping = false;
  if (!shouldManage()) {
    log('not managed (development). Set MSDS_MANAGE_LOCAL_SERVER=1 to enable.');
    return { managed: false, running: await probeStatus(), error: null };
  }

  // Someone else (manual run, previous instance) already owns port 5000.
  if (await probeStatus()) {
    log('an instance is already listening on', STATUS_URL, '- reusing it.');
    return { managed: false, running: true, error: null };
  }

  const dir = localServerDir();
  if (!dir) {
    const error = 'local-server/camera_server.py not found (checked resourcesPath and repo).';
    logErr(error);
    return { managed: true, running: false, error };
  }

  // Installed resources may be read-only (for example under Program Files).
  // Python environments, downloads and MediaMTX generated files belong to the
  // current user's data directory and survive application updates.
  const runtimeDir = app.isPackaged ? path.join(app.getPath('userData'), 'camera-runtime') : dir;
  let boot;
  try {
    fs.mkdirSync(runtimeDir, { recursive: true });
    boot = await bootstrapEnvironment(dir, runtimeDir);
  } catch (exc) {
    const error = `Could not prepare the local camera runtime: ${exc.message}`;
    setPhase('error', error);
    return { managed: true, running: false, error, dir, bootstrap: getBootstrapStatus() };
  }
  if (!boot.ok) {
    logErr(boot.error);
    return { managed: true, running: false, error: boot.error, dir, bootstrap: getBootstrapStatus() };
  }
  if (stopping) return { managed: true, running: false, error: 'Local camera startup was cancelled.', dir };

  const python = resolvePython(runtimeDir);
  if (!python) {
    const error =
      'No Python interpreter found. Install Python 3.10+ or set MSDS_PYTHON_EXE to python.exe.';
    logErr(error);
    return { managed: true, running: false, error, dir, bootstrap: getBootstrapStatus() };
  }


  log('dir     :', dir);
  log('python  :', python.exe, python.args.join(' '));
  log('runtime :', runtimeDir);

  try {
    childError = null;
    child = spawn(python.exe, [...python.args, path.join(dir, 'camera_server.py')], {
      cwd: runtimeDir,
      env: childEnv(dir, runtimeDir),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
  } catch (exc) {
    const error = `Failed to spawn Python: ${exc.message}`;
    logErr(error);
    return { managed: true, running: false, error, dir };
  }

  child.stdout.on('data', (b) => process.stdout.write(`[local-server] ${b}`));
  child.stderr.on('data', (b) => process.stderr.write(`[local-server] ${b}`));
  child.on('error', (exc) => {
    childError = `Failed to start the local camera server: ${exc.message}`;
    logErr(childError);
    child = null;
  });
  child.on('exit', (code, signal) => {
    if (!stopping) {
      childError = `Local camera server exited (code=${code} signal=${signal}).`;
      logErr(childError);
    }
    child = null;
  });

  const ready = await waitForReady();
  if (ready) {
    setPhase('ready', `ready at ${STATUS_URL}`);
    return { managed: true, running: true, error: null, pythonPath: python.exe, dir, bootstrap: getBootstrapStatus() };
  }

  const error = childError ||
    'Local camera server did not answer /status within 30s. The app will open, but CCTV ' +
    'streaming/Whisper will be unavailable until it starts. Check the log above, or run ' +
    'local-server\\start_server.bat manually.';
  logErr(error);
  bootstrap = { ...bootstrap, phase: 'error', message: error };
  return { managed: true, running: false, error, pythonPath: python.exe, dir, bootstrap: getBootstrapStatus() };
}


/**
 * Kill the bridge and every descendant (MediaMTX, ffmpeg).
 * Windows: taskkill /T /F is the only reliable tree kill.
 */
function killProcessTree(proc) {
  if (!proc || proc.exitCode !== null || !proc.pid) return;
  const pid = proc.pid;
  try {
    if (IS_WINDOWS) {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      try { process.kill(-pid, 'SIGTERM'); } catch { proc.kill('SIGTERM'); }
      setTimeout(() => { try { if (proc.exitCode === null) proc.kill('SIGKILL'); } catch { /* gone */ } }, 3000);
    }
  } catch (exc) {
    logErr('stop failed (process may already be gone):', exc.message);
  }
}

function stopLocalServer() {
  stopping = true;
  // First-run setup is asynchronous too; quitting must not leave pip or a
  // downloader running, or start the bridge after the window has closed.
  killProcessTree(setupChild);
  if (finishSetup) finishSetup(false);
  if (child) log('stopping local server (pid', child.pid, ')');
  killProcessTree(child);
  child = null;
}

module.exports = { startLocalServer, stopLocalServer, probeStatus, shouldManage, getBootstrapStatus };
