import { EventEmitter } from 'node:events';
import * as requireCrypto from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(options: { override?: boolean; missingBinaries?: boolean; spawnError?: boolean; existingRuntime?: boolean; holdSetup?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'msds-installed-'));
  roots.push(root);
  const source = path.join(root, 'resources', 'local-server');
  const userData = path.join(root, 'user-data');
  const runtime = path.join(userData, 'camera-runtime');
  fs.mkdirSync(path.join(source, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(source, 'camera_server.py'), '# fixture');
  fs.writeFileSync(path.join(source, 'requirements.txt'), 'fastapi\nuvicorn\n');
  fs.writeFileSync(path.join(source, 'fetch_binaries.py'), '# fixture downloader');
  if (!options.missingBinaries) {
    for (const name of ['ffmpeg', 'ffprobe', 'mediamtx']) fs.writeFileSync(path.join(source, 'bin', `${name}.exe`), 'binary');
  }
  const override = path.join(root, 'custom-python.exe');
  if (options.override) fs.writeFileSync(override, 'python');
  if (options.existingRuntime) {
    const py = path.join(runtime, '.venv', 'Scripts', 'python.exe');
    fs.mkdirSync(path.dirname(py), { recursive: true });
    fs.writeFileSync(py, 'python');
    const hash = (value: string) => requireCrypto.createHash('sha1').update(value).digest('hex').slice(0, 16);
    fs.writeFileSync(path.join(runtime, '.venv', '.msds-deps'), `${hash('fastapi\nuvicorn\n')}:${hash(JSON.stringify([py, []]))}`);
  }

  // Make installation resources effectively read-only even when the test
  // runner has permission to write them. First-run setup must use userData.
  const guardedFs = new Proxy(fs, {
    get(target, key) {
      const value = target[key as keyof typeof fs];
      if (['mkdirSync', 'writeFileSync', 'copyFileSync'].includes(String(key))) {
        return (...args: unknown[]) => {
          const destination = String(args[key === 'copyFileSync' ? 1 : 0]);
          if (destination === source || destination.startsWith(source + path.sep)) throw new Error('read-only install');
          return (value as (...args: unknown[]) => unknown)(...args);
        };
      }
      return value;
    },
  });

  let online = false;
  let responseBody: unknown = { cameras: [], mediamtx: true };
  let responseCode = 200;
  const spawn = vi.fn((exe: string, args: string[], opts: { cwd: string; env?: Record<string, string> }) => {
    const proc = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stderr: new EventEmitter(),
      pid: 42, exitCode: null as number | null, kill: vi.fn(),
    });
    queueMicrotask(() => {
      if (args.some((arg) => arg.endsWith('camera_server.py'))) {
        if (options.spawnError) proc.emit('error', new Error('spawn permission denied'));
        else online = true;
        return;
      }
      if (options.holdSetup) return;
      if (args.includes('venv')) {
        const py = path.join(opts.cwd, '.venv', 'Scripts', 'python.exe');
        fs.mkdirSync(path.dirname(py), { recursive: true });
        fs.writeFileSync(py, 'python');
      }
      if (args.some((arg) => arg.endsWith('fetch_binaries.py'))) {
        fs.mkdirSync(path.join(opts.cwd, 'bin'), { recursive: true });
        for (const name of ['ffmpeg', 'ffprobe', 'mediamtx']) fs.writeFileSync(path.join(opts.cwd, 'bin', `${name}.exe`), 'binary');
      }
      proc.exitCode = 0;
      proc.emit('close', 0);
    });
    return proc;
  });
  const spawnSync = vi.fn((_exe: string, _args: string[]) => ({ status: 0 }));
  const http = {
    get: vi.fn((_url, _opts, callback) => {
      const req = Object.assign(new EventEmitter(), { destroy: vi.fn() });
      queueMicrotask(() => {
        if (!online) { req.emit('error', new Error('offline')); return; }
        const res = Object.assign(new EventEmitter(), { statusCode: responseCode, resume: vi.fn(), setEncoding: vi.fn() });
        callback(res);
        res.emit('data', typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody));
        res.emit('end');
      });
      return req;
    }),
  };
  const env = { MSDS_LOCAL_SERVER_DIR: source, ...(options.override ? { MSDS_PYTHON_EXE: override } : {}) };
  const module = { exports: {} as { startLocalServer: () => Promise<{ running: boolean; error: string | null; pythonPath?: string }>; stopLocalServer: () => void; probeStatus: () => Promise<boolean> } };
  const entry = path.resolve('electron/localServer.cjs');
  vm.runInNewContext(fs.readFileSync(entry, 'utf8'), {
    module, __dirname: path.dirname(entry),
    process: { platform: 'win32', env, resourcesPath: path.dirname(source), stdout: { write: vi.fn() }, stderr: { write: vi.fn() } },
    console: { log: vi.fn(), error: vi.fn() }, setTimeout, clearTimeout,
    require: (name: string) => {
      if (name === 'electron') return { app: { isPackaged: true, getPath: () => userData } };
      if (name === 'child_process') return { spawn, spawnSync };
      if (name === 'fs') return guardedFs;
      if (name === 'http') return http;
      if (name === 'path') return path;
      if (name === 'crypto') return requireCrypto;
      throw new Error(`unexpected require: ${name}`);
    },
  });
  return {
    ...module.exports, source, runtime, override, spawn, spawnSync,
    respond(body: unknown, code = 200) { online = true; responseBody = body; responseCode = code; },
  };
}

describe('installed camera supervisor', () => {
  it('boots from read-only resources with a writable, reusable user runtime', async () => {
    const app = fixture();
    const status = await app.startLocalServer();
    expect(status.running).toBe(true);
    const bridge = app.spawn.mock.calls.find(([, args]) => args.some((arg) => arg.endsWith('camera_server.py')))!;
    expect(bridge[0]).toBe(path.join(app.runtime, '.venv', 'Scripts', 'python.exe'));
    expect(bridge[1]).toEqual([path.join(app.source, 'camera_server.py')]);
    expect(bridge[2].cwd).toBe(app.runtime);
    expect(bridge[2].env?.MSDS_RUNTIME_DIR).toBe(app.runtime);
    expect(bridge[2].env?.MEDIAMTX_EXE).toBe(path.join(app.source, 'bin', 'mediamtx.exe'));
    expect(fs.existsSync(path.join(app.runtime, '.venv', '.msds-deps'))).toBe(true);
    // Long setup operations must be spawned asynchronously to keep the window
    // and its bootstrap-status IPC responsive throughout installation.
    expect(app.spawnSync.mock.calls.every(([, args]) => args[args.length - 1] === '--version')).toBe(true);
    app.stopLocalServer();
  });

  it('installs and runs dependencies with the explicit Python override', async () => {
    const app = fixture({ override: true, existingRuntime: true });
    const status = await app.startLocalServer();
    expect(status.running).toBe(true);
    expect(status.pythonPath).toBe(app.override);
    expect(app.spawn.mock.calls.every(([exe]) => exe === app.override)).toBe(true);
    expect(app.spawn.mock.calls.some(([, args]) => args.includes('venv'))).toBe(false);
    expect(app.spawn.mock.calls.some(([, args]) => args.includes('pip'))).toBe(true);
    app.stopLocalServer();
  });

  it('reuses installed dependencies on later launches', async () => {
    const app = fixture({ existingRuntime: true });
    expect((await app.startLocalServer()).running).toBe(true);
    expect(app.spawn.mock.calls).toHaveLength(1);
    expect(app.spawn.mock.calls[0][1]).toEqual([path.join(app.source, 'camera_server.py')]);
    app.stopLocalServer();
  });

  it('downloads missing binaries into the user runtime and pins them for Python', async () => {
    const app = fixture({ missingBinaries: true });
    expect((await app.startLocalServer()).running).toBe(true);
    const download = app.spawn.mock.calls.find(([, args]) => args.some((arg) => arg.endsWith('fetch_binaries.py')))!;
    expect(download[1]).toContain(path.join(app.runtime, 'fetch_binaries.py'));
    expect(download[2].cwd).toBe(app.runtime);
    const bridge = app.spawn.mock.calls.find(([, args]) => args.some((arg) => arg.endsWith('camera_server.py')))!;
    expect(bridge[2].env?.MEDIAMTX_EXE).toBe(path.join(app.runtime, 'bin', 'mediamtx.exe'));
    app.stopLocalServer();
  });

  it('reports asynchronous spawn errors without crashing or waiting thirty seconds', async () => {
    const app = fixture({ spawnError: true });
    const status = await app.startLocalServer();
    expect(status.running).toBe(false);
    expect(status.error).toContain('spawn permission denied');
  });

  it('cancels first-run processes when the application exits', async () => {
    const app = fixture({ holdSetup: true });
    const startup = app.startLocalServer();
    await new Promise((resolve) => setTimeout(resolve, 0));
    app.stopLocalServer();
    const status = await startup;
    expect(status.running).toBe(false);
    expect(status.error).toContain('cancelled');
    expect(app.spawn.mock.calls).toHaveLength(1);
    expect(app.spawnSync.mock.calls.some(([exe, args]) => exe === 'taskkill' && args.includes('/T'))).toBe(true);
  });

  it('does not mistake an unrelated HTTP service for the camera bridge', async () => {
    const app = fixture();
    app.respond('<html>Not found</html>', 404);
    expect(await app.probeStatus()).toBe(false);
    app.respond('<html>Another app</html>');
    expect(await app.probeStatus()).toBe(false);
    app.respond({ cameras: [], mediamtx: false });
    expect(await app.probeStatus()).toBe(true);
  });
});
