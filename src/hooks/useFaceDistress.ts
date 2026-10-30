import { useEffect, useRef, useState, useCallback } from 'react';
import * as faceapi from '@vladmandic/face-api';
import { estimateHistoryExpression, measureExpressionGeometry } from '@/lib/facialExpressionGeometry';
import {
  advanceDistressFaceConfirmation, emptyDistressFaceConfirmation,
  DISTRESS_FACE_CONFIRM_FRAMES,
} from '@/lib/multimodalDistress';

// Loads pretrained face detection + expression models from a CDN.
// Models are trained on a massive FER+ / AffectNet-style dataset.
// We map the 7 base expressions into a single "distress level".

const MODEL_URL = 'https://cdn.jsdelivr.net/gh/vladmandic/face-api/model';

export type FaceDistress = {
  hasFace: boolean;
  expression: string | null;     // raw dominant expression used ONLY by existing emergency fusion
  /** Corrected display-only expression, never safety fusion evidence. */
  historyExpression?: string;
  historyConfidence?: number;
  /** Geometry correction must be repeated on fresh frames before alarm fusion. */
  historyGeometryCorrected?: boolean;
  /** Safety-only: repeated fresh Face-api observations (never geometry guesses). */
  fusionConfirmed?: boolean;
  probability: number;           // 0..1
  distressScore: number;         // 0..100, how distressed the person is
  distressLevel: 'none' | 'mild' | 'severe';
};

const EMPTY: FaceDistress = {
  hasFace: false,
  expression: null,
  probability: 0,
  distressScore: 0,
  distressLevel: 'none',
};

let modelLoadPromise: Promise<void> | null = null;
function loadModels(): Promise<void> {
  if (modelLoadPromise) return modelLoadPromise;
  modelLoadPromise = (async () => {
    await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
    await faceapi.nets.faceExpressionNet.loadFromUri(MODEL_URL);
    // Optional local geometry: if unavailable, retain original classifier.
    await faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL).catch(() => undefined);
  })();
  return modelLoadPromise;
}

export function useFaceDistress(active: boolean) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [distress, setDistress] = useState<FaceDistress>(EMPTY);
  const busyRef = useRef(false);
  const historyRef = useRef<number[]>([]);
  const confirmationRef = useRef(emptyDistressFaceConfirmation());

  useEffect(() => {
    if (!active) {
      historyRef.current = [];
      confirmationRef.current = emptyDistressFaceConfirmation();
      setDistress(EMPTY);
      return;
    }
    let cancelled = false;
    loadModels()
      .then(() => { if (!cancelled) setReady(true); })
      .catch(err => {
        console.error('[FaceDistress] Failed to load models:', err);
        if (!cancelled) setError(err?.message || 'Failed to load face models');
      });
    return () => { cancelled = true; };
  }, [active]);

  const analyze = useCallback(async (source: HTMLCanvasElement | HTMLVideoElement | null) => {
    if (!ready || !source || busyRef.current) return null;
    busyRef.current = true;
    try {
      const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
      // Landmark inference supplements the existing 7-class probability model
      // for Event History only; any model-loading failure preserves the old path.
      const detections = (faceapi.nets.faceLandmark68TinyNet.isLoaded
        ? await faceapi.detectAllFaces(source, options).withFaceLandmarks(true).withFaceExpressions()
        : await faceapi.detectAllFaces(source, options).withFaceExpressions()) as unknown as Array<{
          detection: { box: { area: number } };
          expressions: Record<string, number>;
          landmarks?: { positions: { x: number; y: number }[] };
        }>;

      if (!detections.length) {
        historyRef.current = [];
        confirmationRef.current = emptyDistressFaceConfirmation();
        setDistress(EMPTY);
        return EMPTY;
      }

      // Pick the largest face
      const main = detections.reduce((biggest, d) => {
        const a = d.detection.box.area;
        return a > biggest.detection.box.area ? d : biggest;
      });

      const expr = main.expressions as unknown as Record<string, number>;
      // The original classifier's score is retained for existing fusion.
      // Event History gets separate, conservative geometric corrections.
      const sad = expr.sad ?? 0;
      const fearful = expr.fearful ?? 0;
      const surprised = expr.surprised ?? 0;
      const angry = expr.angry ?? 0;
      const distressRaw = sad * 1.0 + fearful * 1.4 + surprised * 1.2 + angry * 0.8;
      const instant = Math.min(100, Math.round(distressRaw * 100));
      // Keep the distress score lightly smoothed for display, but do not delay
      // the actual expression label. Alert fusion needs the current camera frame,
      // not a dominant class averaged across several seconds of old snapshots.
      historyRef.current.push(instant);
      if (historyRef.current.length > 3) historyRef.current.shift();
      const distressScore = Math.round(
        historyRef.current.reduce((a, b) => a + b, 0) / historyRef.current.length
      );

      // Use the current frame's expression probabilities so a real change to
      // Angry/Fearful is available to validation immediately. Confidence
      // filtering and multimodal fusion still prevent a single weak frame from
      // becoming an alert.
      let dominant = 'neutral';
      let dominantProb = 0;
      for (const [k, v] of Object.entries(expr)) {
        if (v > dominantProb) { dominantProb = v; dominant = k; }
      }

      // Surprise and neutral reset the safety observation sequence. Geometry
      // corrections are for Event History only, never emergency validation.
      confirmationRef.current = advanceDistressFaceConfirmation(
        confirmationRef.current, dominant, dominantProb, Date.now(),
      );
      const geometry = measureExpressionGeometry(main.landmarks?.positions);
      const historyEstimate = estimateHistoryExpression(expr, geometry);
      const result: FaceDistress = {
        hasFace: true,
        expression: dominant,
        probability: dominantProb,
        historyExpression: historyEstimate.label,
        historyConfidence: historyEstimate.confidence,
        historyGeometryCorrected: historyEstimate.geometryCorrected,
        fusionConfirmed: confirmationRef.current.count >= DISTRESS_FACE_CONFIRM_FRAMES,
        distressScore,
        distressLevel: distressScore > 55 ? 'severe' : distressScore > 25 ? 'mild' : 'none',
      };
      setDistress(result);
      return result;
    } catch (err) {
      console.error('[FaceDistress] analyze error:', err);
      return null;
    } finally {
      busyRef.current = false;
    }
  }, [ready]);

  return { ready, error, distress, analyze };
}