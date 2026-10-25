import { useEffect, useRef, useState } from 'react';
import { drawConnections, drawFaceLandmarkBounds, drawPoints, drawTrail, containedVideoRect, drawQualityConnections, imageLandmarks, usableFaceLandmarks, FACE_68_CONNECTIONS, updateTrail, type TraceTrail } from '@/lib/landmarkRendering';
import { detectFallbackFace68 } from '@/lib/faceLandmarkFallback';
import type { TracePoint } from '@/lib/landmarkRendering';

export interface TracingModes {
  face: boolean;
  body: boolean;
  hands: boolean;
}

interface Props {
  video: HTMLVideoElement;
  modes: TracingModes;
  detail?: 'mesh' | 'outline';
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
export default function MotionTraceOverlay({ video, modes, detail = 'mesh' }: Props) {
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
    let latestFallback: TracePoint[] | null = null;
    let latestFallbackAt = 0;
    let fallbackBusy = false;
    let lastFallbackAttemptAt = 0;
    let fallbackError = '';
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
          latestFallback = null;
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
          let faceLines = 0, poseLines = 0, faceBox = false;
          if (models.face) {
            const faces = models.face.detectForVideo(video, timestamp).faceLandmarks;
            faceCount = faces.length;
            if (faces.length) {
              // Important regression fix: draw RAW, current-frame landmarks.
              // V2 overfiltered/smoothed valid points in some CCTV views.
              // MediaPipe FaceLandmarker does NOT report the same reliable
              // visibility scores as PoseLandmarker. A value of zero here
              // may simply mean "unsupported", not "hidden". The old
              // renderer rejected every connection and produced Face lines 0.
              const face = imageLandmarks(faces[0]);
              if (usableFaceLandmarks(face) && detail === 'mesh') {
                faceLines += drawConnections(ctx, face,
                  tasks.FaceLandmarker.FACE_LANDMARKS_TESSELATION,
                  rect, '#67e8f9', 0.45, 1.0);
              }
              // Restore MediaPipe's COMPLETE contour topology from V1:
              // includes cheeks, brows, nose, eyes and lips. Drawing only
              // specialized face-oval/iris topology hid most features.
              if (usableFaceLandmarks(face)) {
                faceLines += drawConnections(ctx, face,
                  tasks.FaceLandmarker.FACE_LANDMARKS_CONTOURS,
                  rect, '#22d3ee', 1, 2.3);
                faceBox = drawFaceLandmarkBounds(ctx, face, rect);
              }
            }
          }
          // Fallback only when MediaPipe has no usable facial contours.
          // Async face-api inference never blocks the main video loop.
          // It uses the existing face-api dependency, without any identity
          // recognition, changes to safety fusion, or persistent storage.
          let faceSource = faceLines > 0 ? 'MediaPipe 478' : 'no usable landmarks';
          const now = Date.now();
          if (models.face && faceLines < 16) {
            if (!fallbackBusy && now - lastFallbackAttemptAt >= 1200) {
              fallbackBusy = true;
              lastFallbackAttemptAt = now;
              void detectFallbackFace68(video)
                .then(result => {
                  if (disposed) return;
                  latestFallback = result;
                  latestFallbackAt = result ? Date.now() : 0;
                  fallbackError = '';
                })
                .catch(error => {
                  if (disposed) return;
                  fallbackError = error instanceof Error ? error.message : 'model unavailable';
                  latestFallback = null;
                  lastFallbackAttemptAt = Date.now() + 8000;
                })
                .finally(() => { fallbackBusy = false; });
            }
            if (latestFallback && now - latestFallbackAt < 1500) {
              faceLines += drawConnections(ctx, latestFallback, FACE_68_CONNECTIONS,
                rect, '#22d3ee', 1, 2.7);
              faceBox = drawFaceLandmarkBounds(ctx, latestFallback, rect) || faceBox;
              if (faceLines > 0) faceSource = 'face-api 68 fallback';
            }
          } else if (faceLines >= 16) {
            latestFallback = null;
          }

          if (models.pose) {
            const poses = models.pose.detectForVideo(video, timestamp).landmarks;
            poseCount = poses.length;
            if (poses.length) {
              const pose = poses[0];
              const bodyBones = tasks.PoseLandmarker.POSE_CONNECTIONS.filter(
                edge => edge.start >= 11 && edge.end >= 11,
              );
              // V2's minVisibility=.64 and maxLength=.38 erased almost every
              // connection in actual low-angle CCTV. Use attainable bounds,
              // keep the length guard for far-away hallucinated joints.
              const leftShoulder = pose[11], rightShoulder = pose[12];
              // One half-hidden person can produce a "Pose 1" result whose
              // arms and hands all collapse around the face. Require a
              // plausible, visibly separated shoulder pair before drawing.
              const shouldersValid = !!leftShoulder && !!rightShoulder
                && (leftShoulder.visibility ?? 0) >= 0.40
                && (rightShoulder.visibility ?? 0) >= 0.40
                && Math.hypot(leftShoulder.x - rightShoulder.x,
                  leftShoulder.y - rightShoulder.y) >= 0.09;
              if (shouldersValid) {
                poseLines = drawQualityConnections(ctx, pose, bodyBones, rect, '#4ade80',
                  { minVisibility: 0.40, maxLength: 0.48, lineWidth: 3.0, opacity: 0.95 });
                drawPoints(ctx, pose,
                  [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28],
                  rect, '#dcfce7');
              }
              // Motion streaks are meaningful only when several connected
              // bones anchor the skeleton; otherwise they're visual noise.
              for (const wrist of [15, 16]) {
                const observed = pose[wrist];
                const confident = shouldersValid && poseLines >= 5 && observed
                  && (observed.visibility ?? 0) >= 0.65
                  && (observed.presence ?? 1) >= 0.4;
                const trail = updateTrail(paths, `pose-0-${wrist}`,
                  confident ? observed : undefined, rect, 12, rect.width * 0.16);
                drawTrail(ctx, trail, '#bef264');
              }
            } else {
              for (const key of [...paths.keys()]) if (key.startsWith('pose-')) paths.delete(key);
            }
          }
          if (models.hand) {
            const hands = models.hand.detectForVideo(video, timestamp).landmarks;
            handCount = hands.length;
            for (const [index, hand] of hands.entries()) {
              const points = imageLandmarks(hand);
              drawConnections(ctx, points, tasks.HandLandmarker.HAND_CONNECTIONS,
                rect, '#fbbf24', 0.98, 2.8);
              drawPoints(ctx, points, [0, 4, 8, 12, 16, 20], rect, '#fef08a');
              const trail = updateTrail(paths, `hand-${index}`,
                points[8] as TracePoint, rect, 14, rect.width * 0.16);
              drawTrail(ctx, trail, '#fb923c');
            }
            for (const key of [...paths.keys()]) {
              const match = /^hand-(\d+)$/.exec(key);
              if (match && Number(match[1]) >= hands.length) paths.delete(key);
            }
          }
          setMessage(current => {
            const next = showCount(faceCount, poseCount, handCount)
              + (modes.face ? ` · Face lines ${faceLines}${faceBox ? ' + box' : ''} (${faceSource})` : '')
              + (modes.body ? ` · Pose bones ${poseLines}` : '')
              + (models.hand && handCount === 0 ? ' · Raise hands into view' : '')
              + (modes.body && poseCount > 0 && poseLines === 0
                ? ' · Body partly occluded / unreliable' : '')
              + (modes.face && fallbackError && faceLines < 16
                ? ' · fallback failed (see console)' : '');
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
  }, [modes.face, modes.body, modes.hands, video, detail]);

  return (
    <>
      <canvas ref={canvasRef} data-testid="motion-trace-canvas" aria-hidden="true"
        className="pointer-events-none absolute inset-0 h-full w-full" />
      <div data-testid="motion-trace-status" aria-live="polite"
        className="pointer-events-none absolute bottom-3 left-3 max-w-[95%] rounded-lg border border-white/20 bg-slate-950/85 px-3 py-1.5 text-[11px] font-medium text-cyan-50 shadow-lg backdrop-blur-sm"
        title={message}>
        {state === 'loading' ? 'Loading face/body/hand tracing…'
          : state === 'error' ? `Tracing unavailable: ${message}`
            : message}
      </div>
    </>
  );
}
