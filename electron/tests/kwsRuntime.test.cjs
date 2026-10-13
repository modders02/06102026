'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ELECTRON_KWS_DEFAULTS, withElectronKwsDefaults } = require('../kwsRuntime.cjs');
const { BINARIES, missingExecutables, findPython, ensureWindowsBinaries } = require('../../scripts/prepare-electron-binaries.cjs');

test('Electron-managed camera server defaults to KWS-only HELP >=90 mode', () => {
  const env = withElectronKwsDefaults({ LANG: 'en_US.UTF-8' });
  assert.equal(env.MSDS_KWS_VERIFY_ASR, '0');
  assert.equal(env.MSDS_KWS_HELP_RESCUE, '0');
  assert.equal(env.MSDS_KWS_SHORT_HELP_ASR, '0');
  assert.equal(env.MSDS_KWS_HELP_90_FAST_ACCEPT, '1');
  assert.equal(env.LANG, 'en_US.UTF-8');
  assert.equal(Object.keys(ELECTRON_KWS_DEFAULTS).length, 4);
});

test('Electron does not overwrite explicitly specified test/operator flags', () => {
  const env = withElectronKwsDefaults({
    MSDS_KWS_VERIFY_ASR: '1',
    MSDS_KWS_HELP_RESCUE: '1',
    MSDS_KWS_HELP_90_FAST_ACCEPT: '0',
  });
  assert.equal(env.MSDS_KWS_VERIFY_ASR, '1');
  assert.equal(env.MSDS_KWS_HELP_RESCUE, '1');
  assert.equal(env.MSDS_KWS_HELP_90_FAST_ACCEPT, '0');
  assert.equal(env.MSDS_KWS_SHORT_HELP_ASR, '0');
});

test('environment defaults do not mutate the parent environment', () => {
  const original = { MSDS_KWS_VERIFY_ASR: '' };
  const configured = withElectronKwsDefaults(original);
  assert.equal(configured.MSDS_KWS_VERIFY_ASR, '0');
  assert.equal(original.MSDS_KWS_VERIFY_ASR, '');
  assert.equal(original.MSDS_KWS_HELP_90_FAST_ACCEPT, undefined);
});

test('packaging detects absent, tiny, and valid Windows executable files', (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'msds-electron-bin-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  assert.deepEqual(missingExecutables(folder), BINARIES);
  for (const name of BINARIES) {
    fs.writeFileSync(path.join(folder, name), Buffer.alloc(100));
  }
  assert.deepEqual(missingExecutables(folder), BINARIES);
  for (const name of BINARIES) {
    fs.writeFileSync(path.join(folder, name), Buffer.alloc(101 * 1024));
  }
  assert.deepEqual(missingExecutables(folder), []);
  assert.doesNotThrow(() => ensureWindowsBinaries({ directory: folder, verifyOnly: true }));
  fs.unlinkSync(path.join(folder, 'mediamtx.exe'));
  assert.throws(() => ensureWindowsBinaries({ directory: folder, verifyOnly: true }), /mediamtx.exe/);
});

test('Python selector probes an explicit Windows interpreter before PATH', () => {
  const calls = [];
  const runner = (exe, args) => {
    calls.push([exe, ...args]);
    return { status: exe === 'C:\\Custom\\python.exe' ? 0 : 1 };
  };
  const selection = findPython({ MSDS_PYTHON_EXE: 'C:\\Custom\\python.exe' }, runner);
  assert.deepEqual(selection, { exe: 'C:\\Custom\\python.exe', prefix: [] });
  assert.deepEqual(calls, [['C:\\Custom\\python.exe', '--version']]);
});
