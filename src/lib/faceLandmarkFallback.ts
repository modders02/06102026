import { usableFaceLandmarks, type TracePoint, type TraceRect } from '@/lib/landmarkRendering';

/**
 * Display-only distant-face localization. Does NOT change the independent
 * expression/keyword safety-fusion pipeline or infer identity/mood.
 *
 * Use a higher input resolution than the previous 224-pixel full-frame
 * fallback and prioritize an existing, confidently detected PERSON region.
 */
const MODEL_URL = 'https://cdn.jsdelivr.net/gh/vladmandic/face-api/model';
const FAR_FACE_INPUT_SIZE = 512; // multiple of 32 required by TinyFaceDetector
const FACE_SEARCH_THRESHOLD = 0.35;
const LANDMARK_FACE_MIN_SCORE = 0.45;
const BOX_ONLY_MIN_SCORE = 0.70;

type Api = typeof import('@vladmandic/face-api');
let readyPromise: Promise<Api> | null = null;
let landmarksLoaded = false;

/** All coordinates are normalized to the ORIGINAL video, not the crop. */
export interface FaceSearchRegion extends TraceRect {}
export interface FaceFallbackResult {
  landmarks: TracePoint[] | null;
  box: TraceRect;
  score: number;
  source: 'face-api 68' | 'face-api box';
  search: 'person ROI' | 'full frame';
}

type DetectionResult = {
  detection: {
    score: number;
    box: { x: number; y: number; width: number; height: number };
  };
  landmarks?: { positions: { x: number; y: number }[] };
};

function loadFaceApiLandmarks(): Promise<Api> {
  if (readyPromise) return readyPromise;
  readyPromise = import('@vladmandic/face-api').then(async api => {
    // The expression classifier may have loaded the same detector already.
    if (!api.nets.tinyFaceDetector.isLoaded) {
      await api.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
    }
    if (!api.nets.faceLandmark68TinyNet.isLoaded) {
      // Missing landmark weights must not prevent a real detector face BOX
      // from appearing. A box is never used as emotional evidence.
      await api.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL).catch(() => undefined);
    }
    landmarksLoaded = api.nets.faceLandmark68TinyNet.isLoaded;
    return api;
  }).catch(error => {
    readyPromise = null;
    throw error;
  });
  return readyPromise;
}

export function normalizedFace68(
  positions: readonly { x: number; y: number }[], width: number, height: number,
): TracePoint[] | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const result = positions.map(({ x, y }) => ({ x: x / width, y: y / height }));
  return result.length === 68 && usableFaceLandmarks(result) ? result : null;
}

/**
 * Use the upper portion of a detected person's bounding box, allowing for
 * a downward-facing head; this is a SEARCH ROI, not a guessed face box.
 */
export function personFaceSearchRegion(
  person: FaceSearchRegion | null | undefined,
): FaceSearchRegion | null {
  if (!person) return null;
  const { x, y, width, height } = person;
  if (![x, y, width, height].every(Number.isFinite)
      || width <= 0.03 || height <= 0.05
      || x < -0.1 || y < -0.1 || x > 1 || y > 1) return null;
  const left = Math.max(0, x - width * 0.12);
  const top = Math.max(0, y - height * 0.12);
  const right = Math.min(1, x + width * 1.12);
  const bottom = Math.min(1, y + height * 0.72);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function normalizeDetectedFace(
  found: DetectionResult | null | undefined,
  videoWidth: number,
  videoHeight: number,
  crop: FaceSearchRegion = { x: 0, y: 0, width: 1, height: 1 },
  search: FaceFallbackResult['search'] = 'full frame',
): FaceFallbackResult | null {
  if (!found || !videoWidth || !videoHeight) return null;
  const { score, box } = found.detection;
  if (!Number.isFinite(score) || score < LANDMARK_FACE_MIN_SCORE
      || ![box.x, box.y, box.width, box.height].every(Number.isFinite)
      || box.width <= 0 || box.height <= 0) return null;
  const normalized: TraceRect = {
    x: crop.x + (box.x / (videoWidth * crop.width)) * crop.width,
    y: crop.y + (box.y / (videoHeight * crop.height)) * crop.height,
    width: box.width / videoWidth,
    height: box.height / videoHeight,
  };
  // box coordinates returned by face-api are local to its INPUT. For an
  // ROI input of (videoWidth * crop.width), the correct full-image mapping
  // is crop.x + localX/videoWidth, likewise for Y.
  // The normalized box must be on screen, reasonably face-shaped and larger
  // than ~12 source pixels to avoid tiny compression artifacts.
  const aspect = normalized.width / Math.max(normalized.height, 1e-6);
  if (normalized.x < -0.02 || normalized.y < -0.02
      || normalized.x + normalized.width > 1.02
      || normalized.y + normalized.height > 1.02
      || normalized.width * videoWidth < 12
      || normalized.height * videoHeight < 12
      || aspect < 0.45 || aspect > 2.2) return null;

  const region = {
    x: crop.x * videoWidth, y: crop.y * videoHeight,
    width: crop.width * videoWidth, height: crop.height * videoHeight,
  };
  const landmarks = found.landmarks?.positions
    ? normalizedFace68(
      found.landmarks.positions.map(point => ({
        x: region.x + point.x, y: region.y + point.y,
      })),
      videoWidth, videoHeight,
    )
    : null;
  // No landmarks -> accept a detector-only bounding box only when the
  // detector is sufficiently confident, never a COCO person guess.
  if (!landmarks && score < BOX_ONLY_MIN_SCORE) return null;
  return {
    landmarks, box: normalized, score,
    source: landmarks ? 'face-api 68' : 'face-api box', search,
  };
}

async function detectOnSource(
  api: Api, source: HTMLCanvasElement | HTMLVideoElement, video: HTMLVideoElement,
  crop: FaceSearchRegion, search: FaceFallbackResult['search'],
): Promise<FaceFallbackResult | null> {
  const options = new api.TinyFaceDetectorOptions({
    inputSize: FAR_FACE_INPUT_SIZE, scoreThreshold: FACE_SEARCH_THRESHOLD,
  });
  let result: DetectionResult | undefined;
  if (landmarksLoaded) {
    try {
      result = (await api.detectSingleFace(source, options)
        .withFaceLandmarks(true)) as unknown as DetectionResult | undefined;
    } catch {
      // Landmark inference sometimes fails on downward/side-facing subjects.
      // The detector-only result can still draw an explicitly labelled box,
      // but only above the stricter box-only confidence threshold.
    }
  }
  if (!result) {
    result = (await api.detectSingleFace(source, options)) as unknown as DetectionResult | undefined;
  }
  return normalizeDetectedFace(result, video.videoWidth, video.videoHeight, crop, search);
}

export async function detectDistantFace(
  video: HTMLVideoElement, person?: FaceSearchRegion | null,
): Promise<FaceFallbackResult | null> {
  if (!video.videoWidth || !video.videoHeight || video.readyState < 2) return null;
  const api = await loadFaceApiLandmarks();
  const roi = personFaceSearchRegion(person);
  if (roi) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * roi.width));
    canvas.height = Math.max(1, Math.round(video.videoHeight * roi.height));
    const ctx = canvas.getContext('2d');
    if (ctx) {
      try {
        ctx.drawImage(video,
          roi.x * video.videoWidth, roi.y * video.videoHeight,
          roi.width * video.videoWidth, roi.height * video.videoHeight,
          0, 0, canvas.width, canvas.height);
        const found = await detectOnSource(api, canvas, video, roi, 'person ROI');
        if (found) return found;
      } catch {
        // A restricted/tainted video canvas must not crash the display-only
        // overlay. The independent full-frame fallback can still run.
      }
    }
  }
  return detectOnSource(
    api, video, video, { x: 0, y: 0, width: 1, height: 1 }, 'full frame',
  );
}

/** Compatibility with other optional users of the 68-landmark-only helper. */
export async function detectFallbackFace68(video: HTMLVideoElement): Promise<TracePoint[] | null> {
  return (await detectDistantFace(video))?.landmarks ?? null;
}
