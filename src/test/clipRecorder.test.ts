import { Blob as NodeBlob } from 'node:buffer';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createClipStorage } = require('../../electron/clipStorage.cjs');
const clip = () => new NodeBlob(['camera recording'], { type: 'video/webm' }) as unknown as Blob;

function browserFolder() {
  const writable = { write: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
  const handle = {
    name: 'Private recording folder',
    requestPermission: vi.fn().mockResolvedValue('granted'),
    queryPermission: vi.fn().mockResolvedValue('granted'),
    getFileHandle: vi.fn().mockResolvedValue({ createWritable: vi.fn().mockResolvedValue(writable) }),
  };
  const picker = vi.fn().mockResolvedValue(handle);
  Object.defineProperty(window, 'showDirectoryPicker', { value: picker, configurable: true });
  return { handle, writable, picker };
}

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  delete window.msds;
  Reflect.deleteProperty(window, 'showDirectoryPicker');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('automatic clip saving', () => {
  it('reports an unselected folder without picking a location or starting a download', async () => {
    const { picker } = browserFolder();
    localStorage.setItem('msds-clip-folder-label', 'A stale folder label');
    const createElement = vi.spyOn(document, 'createElement');
    const { saveClip, getClipFolderLabel } = await import('@/lib/clipRecorder');
    await expect(saveClip(clip(), 'emergency.webm')).rejects.toThrow('No folder selected.');
    expect(picker).not.toHaveBeenCalled();
    expect(createElement).not.toHaveBeenCalled();
    expect(getClipFolderLabel()).toBe('');
  });

  it('saves directly into the chosen browser folder without repeating permission or location prompts', async () => {
    const { picker, handle, writable } = browserFolder();
    const { pickClipFolder, saveClip } = await import('@/lib/clipRecorder');
    expect(await pickClipFolder()).toBe('Folder selected.');
    const blob = clip();
    await expect(saveClip(blob, 'emergency.webm')).resolves.toBeUndefined();
    expect(picker).toHaveBeenCalledTimes(1);
    expect(handle.requestPermission).toHaveBeenCalledTimes(1);
    expect(handle.getFileHandle).toHaveBeenCalledWith('emergency.webm', { create: true });
    expect(writable.write).toHaveBeenCalledWith(blob);
    expect(writable.close).toHaveBeenCalledOnce();
  });

  it('requires choosing the folder again when permission is unavailable without triggering a prompt', async () => {
    const { picker, handle } = browserFolder();
    const { pickClipFolder, saveClip } = await import('@/lib/clipRecorder');
    await pickClipFolder();
    handle.queryPermission.mockResolvedValue('prompt');
    await expect(saveClip(clip(), 'emergency.webm')).rejects.toThrow('Choose the folder again.');
    expect(picker).toHaveBeenCalledTimes(1);
    expect(handle.requestPermission).toHaveBeenCalledTimes(1);
    expect(handle.getFileHandle).not.toHaveBeenCalled();
  });

  it('reports browser write failures without a download fallback or exposing the destination', async () => {
    const { writable } = browserFolder();
    const { pickClipFolder, saveClip } = await import('@/lib/clipRecorder');
    await pickClipFolder();
    writable.write.mockRejectedValue(new Error('Access denied: C:\\Private\\recording.webm'));
    const createElement = vi.spyOn(document, 'createElement');
    await expect(saveClip(clip(), 'emergency.webm')).rejects.toThrow('Could not save the clip to the selected folder.');
    expect(createElement).not.toHaveBeenCalled();
  });

  it('uses the native Electron folder and saves bytes without a file picker', async () => {
    const bridge = {
      isElectron: true,
      getClipFolder: vi.fn().mockResolvedValue({ selected: true }),
      pickClipFolder: vi.fn(),
      saveClip: vi.fn().mockResolvedValue({ ok: true }),
    };
    window.msds = bridge as unknown as Window['msds'];
    const { saveClip, restoreClipFolder, clipFolderSupported } = await import('@/lib/clipRecorder');
    expect(clipFolderSupported()).toBe(true);
    expect(await restoreClipFolder()).toBe('Folder selected.');
    await expect(saveClip(clip(), 'emergency.webm')).resolves.toBeUndefined();
    expect(bridge.saveClip).toHaveBeenCalledWith('emergency.webm', expect.any(Uint8Array));
    expect(bridge.pickClipFolder).not.toHaveBeenCalled();
  });

  it('reports no Electron folder before sending a recording to the main process', async () => {
    const bridge = {
      isElectron: true,
      getClipFolder: vi.fn().mockResolvedValue({ selected: false }),
      saveClip: vi.fn(),
      pickClipFolder: vi.fn(),
    };
    window.msds = bridge as unknown as Window['msds'];
    const { saveClip } = await import('@/lib/clipRecorder');
    await expect(saveClip(clip(), 'emergency.webm')).rejects.toThrow('No folder selected.');
    expect(bridge.saveClip).not.toHaveBeenCalled();
    expect(bridge.pickClipFolder).not.toHaveBeenCalled();
  });
});

describe('native designated recording folder', () => {
  let fixture: string;
  let configPath: string;
  let pickDirectory: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    fixture = await mkdtemp(path.join(tmpdir(), 'msds-clip-test-'));
    configPath = path.join(fixture, 'settings', 'clip-folder.json');
    pickDirectory = vi.fn().mockResolvedValue(fixture);
  });

  afterEach(async () => {
    // Cleanup is restricted to this test's freshly-created temporary directory.
    if (path.dirname(fixture) !== path.resolve(tmpdir()) || !path.basename(fixture).startsWith('msds-clip-test-')) {
      throw new Error('Unexpected clip test cleanup target.');
    }
    await rm(fixture, { recursive: true, force: true });
  });

  const storage = () => createClipStorage({ getConfigPath: () => configPath, pickDirectory });

  it('returns no folder selected without opening a dialog', async () => {
    expect(await storage().saveClip('emergency.webm', new Uint8Array([1, 2, 3])))
      .toEqual({ ok: false, error: 'No folder selected.' });
    expect(pickDirectory).not.toHaveBeenCalled();
  });

  it('writes into the selected folder and restores that designation on the next app launch', async () => {
    const firstLaunch = storage();
    expect(await firstLaunch.pickClipFolder()).toEqual({ selected: true });
    const nextLaunch = storage();
    expect(await nextLaunch.getClipFolder()).toEqual({ selected: true });
    expect(await nextLaunch.saveClip('emergency.webm', new Uint8Array([1, 2, 3]))).toEqual({ ok: true });
    expect(Array.from(await readFile(path.join(fixture, 'emergency.webm')))).toEqual([1, 2, 3]);
    expect(pickDirectory).toHaveBeenCalledTimes(1);
  });

  it('keeps the selected folder when a later selection is cancelled', async () => {
    const clips = storage();
    await clips.pickClipFolder();
    pickDirectory.mockResolvedValue(null);
    expect(await clips.pickClipFolder()).toEqual({ selected: true, cancelled: true });
    expect(await clips.saveClip('emergency.webm', new Uint8Array([1]))).toEqual({ ok: true });
  });

  it('rejects filenames outside the designated folder and hides paths on write failures', async () => {
    const clips = storage();
    await clips.pickClipFolder();
    expect(await clips.saveClip('../outside.webm', new Uint8Array([1]))).toEqual({ ok: false, error: 'Invalid clip data.' });
    expect(await clips.saveClip('..\\outside.webm', new Uint8Array([1]))).toEqual({ ok: false, error: 'Invalid clip data.' });
    await clips.saveClip('emergency.webm', new Uint8Array([1]));
    expect(await clips.saveClip('emergency.webm', new Uint8Array([2])))
      .toEqual({ ok: false, error: 'Could not save the clip to the selected folder.' });
    expect(Array.from(await readFile(path.join(fixture, 'emergency.webm')))).toEqual([1]);
  });

  it('forgets the destination across app launches', async () => {
    const clips = storage();
    await clips.pickClipFolder();
    await clips.forgetClipFolder();
    expect(await storage().getClipFolder()).toEqual({ selected: false });
  });
});
