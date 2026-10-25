import { useEffect, useRef, useState } from 'react';
import { drawConnections, drawPoints, drawTrail, containedVideoRect, updateTrail, type TraceTrail } from '@/lib/landmarkRendering';
import type { TracePoint } from '@/lib/landmarkRendering';

export interface TracingModes {
  face: boolean;
  body: boolean;
  hands: boolean;
}

interface Props {
  video: HTMLVideoElement;
  modes: TracingModes;
}

const VISION_VERSION = '1.1.1';
const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}/wasm`;
const MODEL_ROOT = 'https://storage.googleapis.com/mediapipe-models';
const FACE_MODEL = `${MODEL_ROOT}/face_landmarker/face_landmarker/float16/1/face_landmarker.task`;
const POSE_MODEL = `${MODEL_ROOT}/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`;
const HAND_MODEL = `${MODEL_ROOT}/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`;
/** Maximum ~3 analyses/second per visible camera; avoids saturating Electron. */
const FRAME_INTERVAL_MS = 350;

type VisionTasks = typeof import('@mediapipe/tasks-vision');
type FaceModel = InstanceType<VisionTasks['FaceLandmarker']>;
type PoseModel = InstanceType<VisionTasks['PoseLandmarker']>;
type HandModel = InstanceType<VisionTasks['HandLandmarker']>;
interface Models {
  face: FaceModel | null;
  pose: PoseModel | null;
  hand: HandModel | null;
}

let sharedFileset: Promise<Awaited<ReturnType<VisionTasks['FilesetResolver']['forVisionTasks']>>> | null = null;
async function modelsFor(modes: TracingModes): Promise<{ tasks: VisionTasks; models: Models }> {
  // No CDN downloads occur until the user explicitly enables tracing.
  const tasks = await import('@mediapipe/tasks-vision');
  sharedFileset ??= tasks.FilesetResolver.forVisionTasks(WASM_URL).catch(error => {
    sharedFileset = null; // allow a new attempt after switching tracing off/on
    throw error;
  });
  const fileset = await sharedFileset;
  const models: Models = { face: null, pose: null, hand: null };
  try {
    if (modes.face) {
      models.face = await tasks.FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: FACE_MODEL, delegate: 'CPU' },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: false,
        minFaceDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
    }
    if (modes.body) {
      models.pose = await tasks.PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: POSE_MODEL, delegate: 'CPU' },
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
    }
    if (modes.hands) {
      models.hand = await tasks.HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: HAND_MODEL, delegate: 'CPU' },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
    }
    return { tasks, models };
  } catch (error) {
    models.face?.close();
    models.pose?.close();
    models.hand?.close();
    throw error;
  }
}

function showCount(face: number, pose: number, hands: number): string {
  return `Face ${face} · Body ${pose} · Hands ${hands}`;
}

/**
 * Diagnostic view only. Reads the existing, already-mounted video element.
 * No extra RTSP/WebRTC connection, persistent biometrics, identity recognition
 * or emergency-acceptance side effects. The main KWS/facial fusion is unchanged.
 */
export default function MotionTraceOverlay({ video, modes }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<'loading' | 'active' | 'error'>('loading');
  const [message, setMessage] = useState('Loading tracing models…');

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let owned: Models | null = null;
    const paths = new Map<string, TraceTrail>();
    let lastTimestamp = 0;
    let lastVideoTime = -1;
    setState('loading');
    setMessage('Loading tracing models…');

    const clearCanvas = () => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    };

    const schedule = (run: () => void) => {
      if (!disposed) timer = setTimeout(run, FRAME_INTERVAL_MS);
    };

    void modelsFor(modes).then(({ tasks, models }) => {
      if (disposed) {
        models.face?.close();
        models.pose?.close();
        models.hand?.close();
        return;
      }
      owned = models;
      setState('active');
      setMessage('Tracing active');

      const analyze = () => {
        if (disposed) return;
        if (document.visibilityState === 'hidden' || video.readyState < 2
            || video.paused || !video.videoWidth || !video.videoHeight) {
          clearCanvas();
          paths.clear();
          lastVideoTime = -1;
          schedule(analyze);
          return;
        }
        const canvas = canvasRef.current;
        const width = canvas?.clientWidth ?? 0;
        const height = canvas?.clientHeight ?? 0;
        if (!canvas || !width || !height) {
          schedule(analyze);
          return;
        }
        const ctx = canvas.getContext('2d');
        if (!ctx) { setState('error'); setMessage('2D canvas unavailable'); return; }
        // A background HLS frame might not advance; avoid reprocessing stale frames.
        if (video.currentTime === lastVideoTime) {
          schedule(analyze);
          return;
        }
        lastVideoTime = video.currentTime;
        const dpr = Math.min(window.devicePixelRatio || 1, 1.5, 960 / width);
        const pixelWidth = Math.round(width * dpr);
        const pixelHeight = Math.round(height * dpr);
        if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
        if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
        ctx.clearRect(0, 0, pixelWidth, pixelHeight);
        const rect = containedVideoRect(pixelWidth, pixelHeight, video.videoWidth, video.videoHeight);
        const timestamp = Math.max(lastTimestamp + 1, performance.now());
        lastTimestamp = timestamp;

        try {
          let faceCount = 0, poseCount = 0, handCount = 0;
          if (models.face) {
            const faces = models.face.detectForVideo(video, timestamp).faceLandmarks;
            faceCount = faces.length;
            for (const face of faces) {
              drawConnections(ctx, face, tasks.FaceLandmarker.FACE_LANDMARKS_TESSELATION, rect, '#7dd3fc', 0.25, 0.8);
              drawConnections(ctx, face, tasks.FaceLandmarker.FACE_LANDMARKS_CONTOURS, rect, '#22d3ee', 0.95, 1.8);
            }
          }
          if (models.pose) {
            const poses = models.pose.detectForVideo(video, timestamp).landmarks;
            poseCount = poses.length;
            for (const [index, pose] of poses.entries()) {
              drawConnections(ctx, pose, tasks.PoseLandmarker.POSE_CONNECTIONS, rect, '#4ade80', 0.92, 3);
              drawPoints(ctx, pose, [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28], rect, '#dcfce7');
              // Wrist trails are observational only; indices are NOT person IDs.
              for (const wrist of [15, 16]) {
                const trail = updateTrail(paths, `pose-${index}-${wrist}`, pose[wrist], rect);
                drawTrail(ctx, trail, '#a3e635');
              }
            }
            if (!poses.length) {
              for (const key of [...paths.keys()]) if (key.startsWith('pose-')) paths.delete(key);
            }
          }
          if (models.hand) {
            const hands = models.hand.detectForVideo(video, timestamp).landmarks;
            handCount = hands.length;
            for (const [index, hand] of hands.entries()) {
              drawConnections(ctx, hand, tasks.HandLandmarker.HAND_CONNECTIONS, rect, '#fbbf24', 0.95, 2);
              drawPoints(ctx, hand, [0, 4, 8, 12, 16, 20], rect, '#fef08a');
              const trail = updateTrail(paths, `hand-${index}`, hand[8] as TracePoint, rect);
              drawTrail(ctx, trail, '#fb923c');
            }
            if (!hands.length) {
              for (const key of [...paths.keys()]) if (key.startsWith('hand-')) paths.delete(key);
            }
          }
          setMessage(current => {
            const next = showCount(faceCount, poseCount, handCount);
            return next === current ? current : next;
          });
          schedule(analyze);
        } catch (error) {
          clearCanvas();
          setState('error');
          setMessage(error instanceof Error ? error.message : 'Tracing inference failed');
        }
      };
      schedule(analyze);
    }).catch(error => {
      if (!disposed) {
        setState('error');
        setMessage(error instanceof Error ? error.message : 'Failed to download tracing models');
      }
    });

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      clearCanvas();
      paths.clear();
      owned?.face?.close();
      owned?.pose?.close();
      owned?.hand?.close();
    };
  }, [modes.face, modes.body, modes.hands, video]);

  return (
    <>
      <canvas ref={canvasRef} data-testid="motion-trace-canvas" aria-hidden="true"
        className="pointer-events-none absolute inset-0 h-full w-full" />
      <div data-testid="motion-trace-status" aria-live="polite"
        className="pointer-events-none absolute bottom-2 left-2 max-w-[90%] truncate rounded bg-black/70 px-2 py-1 text-[11px] text-white"
        title={message}>
        {state === 'loading' ? 'Loading face/body/hand tracing…'
          : state === 'error' ? `Tracing unavailable: ${message}`
            : message}
      </div>
    </>
  );
}
