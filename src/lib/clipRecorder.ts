/**
 * Emergency clip recorder.
 *
 * When an emergency is detected the camera view records a short video clip
 * (default 10 seconds) straight from the live feed and stores it on the
 * user's designated folder. Saving never opens a location picker or falls
 * back to Downloads; choosing a folder is an explicit settings action.
 */

import { isDesktop } from './desktop';

const FOLDER_LABEL_KEY = 'msds-clip-folder-label';
const CLIP_SECONDS_KEY = 'msds-clip-seconds';
const FOLDER_DB = 'msds-clip-settings';
const FOLDER_STORE = 'settings';
const FOLDER_HANDLE_KEY = 'clip-folder';
const SELECTED_FOLDER_LABEL = 'Folder selected.';

type DirHandle = {
  name: string;
  requestPermission?: (opts: { mode: 'readwrite' }) => Promise<PermissionState>;
  queryPermission?: (opts: { mode: 'readwrite' }) => Promise<PermissionState>;
  getFileHandle: (name: string, opts?: { create?: boolean }) => Promise<{
    createWritable: () => Promise<{ write: (data: Blob) => Promise<void>; close: () => Promise<void> }>;
  }>;
};

let folder: DirHandle | null = null;

/** Directory handles can be cloned into IndexedDB, unlike localStorage. */
function storedFolder(action: 'read' | 'write' | 'delete', handle?: DirHandle): Promise<DirHandle | null> {
  return new Promise(resolve => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    let request: IDBOpenDBRequest;
    try { request = indexedDB.open(FOLDER_DB, 1); }
    catch { return resolve(null); }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(FOLDER_STORE)) request.result.createObjectStore(FOLDER_STORE);
    };
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
    request.onsuccess = () => {
      const db = request.result;
      let result: DirHandle | null = null;
      try {
        const transaction = db.transaction(FOLDER_STORE, action === 'read' ? 'readonly' : 'readwrite');
        const store = transaction.objectStore(FOLDER_STORE);
        const operation = action === 'read' ? store.get(FOLDER_HANDLE_KEY)
          : action === 'write' ? store.put(handle, FOLDER_HANDLE_KEY) : store.delete(FOLDER_HANDLE_KEY);
        operation.onsuccess = () => { if (action === 'read') result = operation.result || null; };
        transaction.oncomplete = () => { db.close(); resolve(result); };
        transaction.onerror = transaction.onabort = () => { db.close(); resolve(null); };
      } catch {
        db.close();
        resolve(null);
      }
    };
  });
}

function rememberFolder(selected: boolean) {
  try {
    if (selected) localStorage.setItem(FOLDER_LABEL_KEY, SELECTED_FOLDER_LABEL);
    else localStorage.removeItem(FOLDER_LABEL_KEY);
  } catch { /* quota */ }
}

export const clipFolderSupported = () =>
  isDesktop() || (typeof window !== 'undefined' && typeof (window as unknown as Record<string, unknown>).showDirectoryPicker === 'function');

export const getClipFolderLabel = () => {
  try { return localStorage.getItem(FOLDER_LABEL_KEY) ? SELECTED_FOLDER_LABEL : ''; } catch { return ''; }
};

/** Refresh settings after restoring the actual folder, including app restarts. */
export async function restoreClipFolder(): Promise<string> {
  const selected = isDesktop()
    ? (await window.msds!.getClipFolder()).selected
    : Boolean(folder || (folder = await storedFolder('read')));
  rememberFolder(selected);
  return selected ? SELECTED_FOLDER_LABEL : '';
}

export const getClipSeconds = () => {
  const raw = Number(localStorage.getItem(CLIP_SECONDS_KEY));
  return Number.isFinite(raw) && raw >= 3 && raw <= 60 ? raw : 10;
};

export const setClipSeconds = (value: number) => {
  try { localStorage.setItem(CLIP_SECONDS_KEY, String(value)); } catch { /* quota */ }
};

/** Ask the user where emergency clips should be saved. */
export async function pickClipFolder(): Promise<string> {
  if (isDesktop()) {
    const result = await window.msds!.pickClipFolder();
    if (result.error) throw new Error(result.error);
    if (result.cancelled) throw new DOMException('Folder selection cancelled.', 'AbortError');
    rememberFolder(result.selected);
    return result.selected ? SELECTED_FOLDER_LABEL : '';
  }
  const picker = (window as unknown as { showDirectoryPicker?: (o?: unknown) => Promise<DirHandle> }).showDirectoryPicker;
  if (!picker) throw new Error('Folder selection is not supported in this browser.');
  const handle = await picker({ id: 'msds-clips', mode: 'readwrite' });
  const permission = await handle.requestPermission?.({ mode: 'readwrite' });
  if (permission && permission !== 'granted') throw new Error('Folder access was not granted.');
  folder = handle;
  await storedFolder('write', handle);
  rememberFolder(true);
  return SELECTED_FOLDER_LABEL;
}

export async function forgetClipFolder(): Promise<void> {
  folder = null;
  rememberFolder(false);
  if (isDesktop()) await window.msds!.forgetClipFolder();
  else await storedFolder('delete');
}

function pickMimeType() {
  const options = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
  return options.find(t => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) || '';
}

/** Record `seconds` of the given live <video> element. */
export function recordClip(video: HTMLVideoElement, seconds = getClipSeconds()): Promise<Blob | null> {
  return new Promise(resolve => {
    try {
      const capture = (video as HTMLVideoElement & { captureStream?: () => MediaStream }).captureStream;
      const stream = capture ? capture.call(video) : null;
      if (!stream || stream.getTracks().length === 0) return resolve(null);
      const mimeType = pickMimeType();
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const parts: Blob[] = [];
      rec.ondataavailable = e => { if (e.data.size) parts.push(e.data); };
      rec.onstop = () => resolve(parts.length ? new Blob(parts, { type: rec.mimeType || 'video/webm' }) : null);
      rec.onerror = () => resolve(null);
      rec.start();
      window.setTimeout(() => { try { rec.stop(); } catch { resolve(null); } }, seconds * 1000);
    } catch {
      resolve(null);
    }
  });
}

/** Save directly to the designated folder. No picker or download is opened. */
export async function saveClip(blob: Blob, filename: string): Promise<void> {
  if (isDesktop()) {
    if (!(await window.msds!.getClipFolder()).selected) throw new Error('No folder selected.');
    const result = await window.msds!.saveClip(filename, new Uint8Array(await blob.arrayBuffer()));
    if (!result.ok) throw new Error(result.error || 'Could not save the clip to the selected folder.');
    return;
  }
  if (!folder) folder = await storedFolder('read');
  if (!folder) {
    rememberFolder(false);
    throw new Error('No folder selected.');
  }
  // Permission prompts require a user's explicit Choose folder action.
  let permission: PermissionState | undefined;
  try { permission = await folder.queryPermission?.({ mode: 'readwrite' }); }
  catch { permission = 'denied'; }
  if (permission && permission !== 'granted') {
    throw new Error('Folder access is unavailable. Choose the folder again.');
  }
  try {
    const file = await folder.getFileHandle(filename, { create: true });
    const writable = await file.createWritable();
    await writable.write(blob);
    await writable.close();
  } catch {
    throw new Error('Could not save the clip to the selected folder.');
  }
}

export const clipFileName = (cameraName: string, type: string) =>
  `${cameraName.replace(/[^\w-]+/g, '_')}-${type}-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`;
