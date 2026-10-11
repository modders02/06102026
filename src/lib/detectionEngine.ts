import * as cocoSsd from '@tensorflow-models/coco-ssd';
import '@tensorflow/tfjs';
import { isRelevantIndoorObject, type DetectedObject } from '@/types/dashboard';

/**
 * Shared COCO-SSD weights (loaded once), but every camera pipeline keeps its
 * own detection state / queue, so cameras never block or clobber each other.
 */
let modelPromise: Promise<cocoSsd.ObjectDetection> | null = null;
let model: cocoSsd.ObjectDetection | null = null;

export function loadDetector() {
  if (!modelPromise) {
    modelPromise = cocoSsd.load({ base: 'mobilenet_v2' }).then(m => {
      model = m;
      return m;
    }).catch(error => {
      modelPromise = null;
      throw error;
    });
  }
  return modelPromise;
}

export const detectorReady = () => model !== null;

export async function detectObjects(
  source: HTMLCanvasElement | HTMLVideoElement,
  minConfidence = 0.4,
): Promise<DetectedObject[]> {
  const m = model ?? (await loadDetector());
  // Ask COCO-SSD for a wider raw pool, then expose only app-relevant indoor
  // classes. This prevents cat/dog/remote/vehicles/sports/outdoor clutter from
  // displacing useful indoor detections in the final 20 results.
  const predictions = await m.detect(source, 40, minConfidence);
  return predictions
    .filter(prediction => isRelevantIndoorObject(prediction.class))
    .slice(0, 20)
    .map(p => ({
      label: p.class,
      confidence: p.score,
      bbox: [p.bbox[0], p.bbox[1], p.bbox[2], p.bbox[3]] as [number, number, number, number],
    }));
}
