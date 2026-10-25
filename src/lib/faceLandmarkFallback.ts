import { usableFaceLandmarks, type TracePoint } from '@/lib/landmarkRendering';

/**
 * Independent, opt-in 68-point facial geometry fallback. This does not reuse
 * or change the safety-critical useFaceDistress hook and never performs
 * identity matching or face embedding extraction.
 */
const MODEL_URL = 'https://cdn.jsdelivr.net/gh/vladmandic/face-api/model';

type Api = typeof import('@vladmandic/face-api');
let readyPromise: Promise<Api> | null = null;

function loadFaceApiLandmarks(): Promise<Api> {
  if (readyPromise) return readyPromise;
  readyPromise = import('@vladmandic/face-api').then(async api => {
    // Face detector is also used by the existing expression pipeline. Load
    // only when absent; avoid needless repeated model downloads.
    if (!api.nets.tinyFaceDetector.isLoaded) {
      await api.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
    }
    if (!api.nets.faceLandmark68TinyNet.isLoaded) {
      await api.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL);
    }
    return api;
  }).catch(error => {
    readyPromise = null; // allow retry if CDN temporarily fails
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

export async function detectFallbackFace68(video: HTMLVideoElement): Promise<TracePoint[] | null> {
  if (!video.videoWidth || !video.videoHeight || video.readyState < 2) return null;
  const api = await loadFaceApiLandmarks();
  const result = await api
    .detectSingleFace(video, new api.TinyFaceDetectorOptions({
      inputSize: 224, scoreThreshold: 0.45,
    }))
    .withFaceLandmarks(true);
  if (!result) return null;
  return normalizedFace68(result.landmarks.positions, video.videoWidth, video.videoHeight);
}
