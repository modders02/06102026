import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const MARKER = 'msds-renderer-storage-migrated-v1';
const SOURCE = '/installed/electron/storageMigration.html';
const DESTINATION = 'msds://app/__storage-migration__';

function fixture(oldValues: Record<string, string> = {}, newValues: Record<string, string> = {}) {
  const legacy = new Map(Object.entries(oldValues));
  const destination = new Map(Object.entries(newValues));
  let current = destination;
  const window = {
    loadURL: vi.fn(async () => { current = destination; }),
    loadFile: vi.fn(async () => { current = legacy; }),
    webContents: {
      executeJavaScript: vi.fn(async (script: string) => vm.runInNewContext(script, {
        localStorage: {
          get length() { return current.size; },
          key: (index: number) => [...current.keys()][index] ?? null,
          getItem: (key: string) => current.get(key) ?? null,
          setItem: (key: string, value: string) => current.set(key, value),
        },
      })),
    },
  };
  const module = { exports: {} as {
    STORAGE_URL: string;
    migrateRendererStorage: (window: unknown, file: string, url?: string) => Promise<{ migrated: boolean; copied: number }>;
  } };
  const warn = vi.fn();
  vm.runInNewContext(fs.readFileSync(path.resolve('electron/rendererStorage.cjs'), 'utf8'), {
    module, console: { warn },
  });
  return { ...module.exports, window, legacy, destination, warn };
}

describe('renderer storage migration', () => {
  it('copies legacy camera and auth state before loading the application, preserving existing destination values', async () => {
    const camera = JSON.stringify({ slots: [{ ip: '192.168.1.10', connected: true }] });
    const fixtureApp = fixture({
      'msd-camera-slots-v1': camera,
      'sb-project-auth-token': 'old-session',
      theme: 'dark',
    }, { theme: 'light', 'sb-project-auth-token': 'current-session' });
    const result = await fixtureApp.migrateRendererStorage(fixtureApp.window, SOURCE, DESTINATION);

    expect(result).toEqual({ migrated: true, copied: 1 });
    expect(fixtureApp.destination.get('msd-camera-slots-v1')).toBe(camera);
    expect(fixtureApp.destination.get('sb-project-auth-token')).toBe('current-session');
    expect(fixtureApp.destination.get('theme')).toBe('light');
    expect(fixtureApp.destination.get(MARKER)).toBe('1');
    expect(fixtureApp.legacy.get('sb-project-auth-token')).toBe('old-session');
    expect(fixtureApp.window.loadFile).toHaveBeenCalledWith(SOURCE);
    expect(fixtureApp.window.loadURL.mock.calls).toEqual([[DESTINATION], [DESTINATION]]);
  });

  it('never restores an old auth session again after logout on the new origin', async () => {
    const fixtureApp = fixture({ 'sb-project-auth-token': 'old-session' });
    await fixtureApp.migrateRendererStorage(fixtureApp.window, SOURCE);
    fixtureApp.destination.delete('sb-project-auth-token');
    fixtureApp.window.loadFile.mockClear();

    expect(await fixtureApp.migrateRendererStorage(fixtureApp.window, SOURCE)).toEqual({ migrated: false, copied: 0 });
    expect(fixtureApp.destination.has('sb-project-auth-token')).toBe(false);
    expect(fixtureApp.window.loadFile).not.toHaveBeenCalled();
  });

  it('marks migration complete even when the legacy origin has no saved state', async () => {
    const fixtureApp = fixture();
    expect(fixtureApp.STORAGE_URL).toBe(DESTINATION);
    expect(await fixtureApp.migrateRendererStorage(fixtureApp.window, SOURCE)).toEqual({ migrated: true, copied: 0 });
    expect(fixtureApp.destination.get(MARKER)).toBe('1');
  });

  it('keeps arbitrary storage keys and quoted values as data', async () => {
    const values = Object.fromEntries([
      ['__proto__', 'prototype key'],
      ['constructor', 'constructor key'],
      ['quoted"key', "line one\n'quote'; throw new Error('must not execute');"],
    ]);
    const fixtureApp = fixture(values);
    expect(await fixtureApp.migrateRendererStorage(fixtureApp.window, SOURCE)).toEqual({ migrated: true, copied: 3 });
    for (const [key, value] of Object.entries(values)) expect(fixtureApp.destination.get(key)).toBe(value);
  });

  it('leaves failures nonfatal and retryable without reporting stored credentials', async () => {
    const fixtureApp = fixture({ password: 'private-password' });
    fixtureApp.window.loadFile.mockRejectedValueOnce(new Error('load failed private-password'));
    expect(await fixtureApp.migrateRendererStorage(fixtureApp.window, SOURCE)).toEqual({ migrated: false, copied: 0 });
    expect(fixtureApp.destination.has(MARKER)).toBe(false);
    expect(fixtureApp.warn).toHaveBeenCalledOnce();
    expect(fixtureApp.warn.mock.calls[0].join(' ')).not.toContain('private-password');

    expect(await fixtureApp.migrateRendererStorage(fixtureApp.window, SOURCE)).toEqual({ migrated: true, copied: 1 });
    expect(fixtureApp.destination.get('password')).toBe('private-password');
  });
});
