import { useEffect, useRef, useState, useCallback } from 'react';
import * as faceapi from '@vladmandic/face-api';

// Loads pretrained face detection + expression models from a CDN.
// Models are trained on a massive FER+ / AffectNet-style dataset.
// We map the 7 base expressions into a single "distress level".

const MODEL_URL = 'https://cdn.jsdelivr.net/gh/vladmandic/face-api/model';

export type FaceDistress = {
  hasFace: boolean;
  expression: string | null;     // dominant expression
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
  })();
  return modelLoadPromise;
}

export function useFaceDistress(active: boolean) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [distress, setDistress] = useState<FaceDistress>(EMPTY);
  const busyRef = useRef(false);
  const historyRef = useRef<number[]>([]);

  useEffect(() => {
    if (!active) {
      historyRef.current = [];
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
      const detections = await faceapi
        .detectAllFaces(source, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 }))
        .withFaceExpressions();

      if (!detections.length) {
        historyRef.current = [];
        setDistress(EMPTY);
        return EMPTY;
      }

      // Pick the largest face
      const main = detections.reduce((biggest, d) => {
        const a = d.detection.box.area;
        return a > biggest.detection.box.area ? d : biggest;
      });

      const expr = main.expressions as unknown as Record<string, number>;
      // Safety distress score keeps the original sadness/fear/anger signal and
      // treats face-api's "surprised" expression as the UI's Frightened state.
      // Disgust and neutral remain non-distress signals.
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

      const result: FaceDistress = {
        hasFace: true,
        expression: dominant,
        probability: dominantProb,
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