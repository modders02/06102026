/**
 * Optional FER sidecar. All images are small face crops transferred solely to
 * the loopback service; FER never automatically authorizes a camera alert.
 */
export type FerEmotionPrediction = {
  label: 'angry' | 'disgust' | 'fearful' | 'happy' | 'sad' | 'surprised' | 'neutral';
  confidence: number;
  runnerUp: number;
};

const FER_URL = 'http://127.0.0.1:5066/analyze';
export const FER_REQUEST_INTERVAL_MS = 1100;
export const FER_REQUEST_TIMEOUT_MS = 2100;
export const FER_RETRY_AFTER_ERROR_MS = 20_000;

const KEY_MAP: Record<string, FerEmotionPrediction['label']> = {
  angry: 'angry', disgust: 'disgust', fear: 'fearful',
  happy: 'happy', sad: 'sad', surprise: 'surprised', neutral: 'neutral',
};

export function parseFerResponse(input: unknown): FerEmotionPrediction | null {
  if (!input || typeof input !== 'object') return null;
  const data = input as Record<string, unknown>;
  if (data.ok !== true || data.has_face !== true || data.engine !== 'fer'
      || !data.scores || typeof data.scores !== 'object') return null;
  const scores = data.scores as Record<string, unknown>;
  const sorted: Array<[string, number]> = [];
  for (const key of Object.keys(KEY_MAP)) {
    const val = scores[key];
    if (typeof val !== 'number' || !Number.isFinite(val) || val < 0 || val > 1) return null;
    sorted.push([key, val]);
  }
  sorted.sort((a, b) => b[1] - a[1]);
  if (!sorted.length || sorted[0][1] === 0) return null;
  return { label: KEY_MAP[sorted[0][0]], confidence: sorted[0][1], runnerUp: sorted[1][1] };
}

/** Crop the largest Face-api detection with generous margins for FER's detector. */
export async function classifyWithFer(
  source: HTMLCanvasElement | HTMLVideoElement,
  box: { x: number; y: number; width: number; height: number },
): Promise<FerEmotionPrediction | null> {
  const w = source instanceof HTMLVideoElement ? source.videoWidth : source.width;
  const h = source instanceof HTMLVideoElement ? source.videoHeight : source.height;
  if (w <= 0 || h <= 0 || box.width < 30 || box.height < 30) return null;
  const span = Math.max(box.width, box.height) * 1.8;
  const left = Math.max(0, Math.floor(box.x + box.width / 2 - span / 2));
  const top = Math.max(0, Math.floor(box.y + box.height / 2 - span / 2));
  const right = Math.min(w, Math.ceil(box.x + box.width / 2 + span / 2));
  const bottom = Math.min(h, Math.ceil(box.y + box.height / 2 + span / 2));
  if (right - left < 40 || bottom - top < 40) return null;

  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 360 / Math.max(right - left, bottom - top));
  canvas.width = Math.max(1, Math.round((right - left) * scale));
  canvas.height = Math.max(1, Math.round((bottom - top) * scale));
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.drawImage(source, left, top, right - left, bottom - top, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.72));
  if (!blob || blob.size > 300_000) return null;

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), FER_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(FER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg' },
      body: blob,
      signal: controller.signal,
      mode: 'cors',
      cache: 'no-store',
    });
    if (!response.ok) throw new Error('FER not available');
    return parseFerResponse(await response.json());
  } finally {
    window.clearTimeout(timeout);
  }
}
