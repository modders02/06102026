'use strict';

/**
 * Before making a Windows installer, provision verified executable paths:
 * local-server/bin/{ffmpeg,ffprobe,mediamtx}.exe
 *
 * fetch_binaries.py uses Python's standard library; no .venv required.
 * An offline build works when all three binaries are already present.
 * Refuse to publish a half-functional installer when a required binary
 * cannot be downloaded or is an empty placeholder.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const LOCAL_SERVER = path.join(REPO, 'local-server');
const BIN = path.join(LOCAL_SERVER, 'bin');
const BINARIES = Object.freeze(['ffmpeg.exe', 'ffprobe.exe', 'mediamtx.exe']);
const MIN_EXECUTABLE_BYTES = 100 * 1024;

function missingExecutables(directory = BIN) {
  return BINARIES.filter((name) => {
    try {
      const info = fs.statSync(path.join(directory, name));
      return !info.isFile() || info.size < MIN_EXECUTABLE_BYTES;
    } catch {
      return true;
    }
  });
}

function findPython(environ = process.env, runner = spawnSync) {
  const attempts = [
    ...(environ.MSDS_PYTHON_EXE ? [[environ.MSDS_PYTHON_EXE]] : []),
    ['py', '-3'],
    ['python'],
  ];
  for (const [exe, ...prefix] of attempts) {
    const probe = runner(exe, [...prefix, '--version'], {
      encoding: 'utf8', windowsHide: true, timeout: 10000,
    });
    if (!probe.error && probe.status === 0) return { exe, prefix };
  }
  return null;
}

function ensureWindowsBinaries(options = {}) {
  const directory = options.directory ?? BIN;
  let missing = missingExecutables(directory);
  if (!missing.length) {
    console.log('[msds:installer] FFmpeg, FFprobe and MediaMTX are present.');
    return;
  }
  if (options.verifyOnly) {
    throw new Error('Missing or invalid packaged binaries: ' + missing.join(', '));
  }
  if (process.platform !== 'win32') {
    throw new Error('Windows installer binary preparation must run on Windows.');
  }
  const python = findPython();
  if (!python) {
    throw new Error('Python 3 was not found. Install Python and rerun the build.');
  }
  console.log('[msds:installer] Fetching missing local-server binaries: ' + missing.join(', '));
  const download = spawnSync(python.exe,
    [...python.prefix, path.join(LOCAL_SERVER, 'fetch_binaries.py')], {
      cwd: LOCAL_SERVER, stdio: 'inherit', windowsHide: true,
      timeout: 15 * 60 * 1000,
    });
  if (download.error || download.status !== 0) {
    throw new Error('Could not download camera binaries; check your network and retry.');
  }
  missing = missingExecutables(directory);
  if (missing.length) {
    throw new Error('Camera binaries are still missing or invalid: ' + missing.join(', '));
  }
  console.log('[msds:installer] Verified 3 Windows camera binaries for packaging.');
}

if (require.main === module) {
  try {
    ensureWindowsBinaries({ verifyOnly: process.argv.includes('--verify-only') });
  } catch (error) {
    console.error('[msds:installer]', error.message);
    process.exitCode = 1;
  }
}

module.exports = { BINARIES, findPython, missingExecutables, ensureWindowsBinaries };
