import { useCallback, useEffect, useRef, useState } from 'react';
import { openCameraWebRtc } from '@/lib/cameraWebRtc';
import { createPlaybackFrameCounter } from '@/lib/cameraPlayback';
import { captureCameraEventSnapshot, captureVideoSnapshot } from '@/lib/cameraEventSnapshot';
import { detectObjects, loadDetector } from '@/lib/detectionEngine';
import { computeSaliency, computeSaliencyScore } from '@/lib/saliency';
import { createFireState, detectFire } from '@/lib/fireDetection';
import { describeAudioStatus, getAudioEvents, getCameraSnapshot } from '@/lib/multiCamServer';
import { useFaceDistress } from '@/hooks/useFaceDistress';
import { matchWakeWord } from '@/lib/safetyLexicon';
import { historyEmotionMeta } from '@/lib/emotionEvents';
import {
  SMOKE_REGION_MIN_RATIO,
  fireSmokeLabel,
  fireSpeechLabel,
  fuseFireWithSunog,
  isImmediateFireSmoke,
  makeFireVisualSignal,
  makeSunogSignal,
  type FireVisualSignal,
  type SunogSignal,
} from '@/lib/fireFusion';
import {
  fuseDistressSignals,
  isMultimodalDistressExpression,
  makeDistressFaceSignal,
  makeDistressSoundSignal,
  makeDistressSpeechSignal,
  multimodalDistressLabel,
  type DistressFaceSignal,
  type DistressSpeechSignal,
} from '@/lib/multimodalDistress';
import type {
  CameraConfig, CameraRuntime, DetectionEvent, MultiCamSettings,
} from '@/types/multicam';
import { hlsUrlFor, webrtcUrlFor } from '@/types/multicam';

const HUMAN_LABELS = new Set(['person']);
/** Live CCTV text disappears this long after the last words were heard. */
const TRANSCRIPT_CLEAR_MS = 5000;
const SNAPSHOT_INTERVAL_MS = 3000;
const PLAYBACK_STALL_MS = 8000;

type FrameCapture = { grabFrame: () => Promise<ImageBitmap> };
type ImageCaptureConstructor = new (track: MediaStreamTrack) => FrameCapture;

/** Decode a still image without opening a video element or a streaming player. */
async function decodeSnapshot(blob: Blob, signal?: AbortSignal): Promise<{
  image: CanvasImageSource;
  width: number;
  height: number;
  close: () => void;
}> {
  if (typeof createImageBitmap === 'function') {
    const image = await createImageBitmap(blob);
    return { image, width: image.width, height: image.height, close: () => image.close() };
  }
  const url = URL.createObjectURL(blob);
  const image = new Image();
  let onAbort: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      onAbort = () => reject(new DOMException('Snapshot cancelled.', 'AbortError'));
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener('abort', onAbort, { once: true });
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('Unable to read camera snapshot.'));
      image.src = url;
    });
    return { image, width: image.naturalWidth, height: image.naturalHeight, close: () => {} };
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    image.onload = null;
    image.onerror = null;
    URL.revokeObjectURL(url);
  }
}

const emptyRuntime = (cameraId: string): CameraRuntime => ({
  cameraId,
  status: 'offline',
  error: null,
  fps: 0,
  latencyMs: 0,
  saliencyScore: 0,
  attentionScore: 0,
  objects: [],
  humanCount: 0,
  fire: { detected: false, confidence: 0 },
  smoke: { detected: false, confidence: 0 },
  faceDistress: { detected: false, label: '', confidence: 0 },
  audioDistress: { detected: false, keyword: '', confidence: 0, transcript: '' },
  transcript: '',
  audioListening: false,
  audio: null,
  audioMessage: 'Connect this camera to start listening.',
  audioTone: 'wait',
  audioBackendReachable: true,
  lastDetectionAt: null,
  detections: 0,
  alerts: 0,
});


interface Options {
  camera: CameraConfig;
  settings: MultiCamSettings;
  onEvent?: (evt: Omit<DetectionEvent, 'id'>) => void;
  /** Own the source video independently of any visible camera card. */
  managedVideo?: boolean;
  /** Streaming playback belongs to the Cameras page; other views use stills. */
  playbackEnabled?: boolean;
  /** Local webcam tracks use still capture outside the live page. */
  sourceStream?: MediaStream | null;
}

/**
 * One fully independent Multimodal Saliency Detection pipeline per camera:
 * its own realtime player, frame queue, fire/saliency state, face session,
 * Whisper audio polling, statistics and fault-tolerant reconnect.
 */
export function useCameraPipeline({ camera, settings, onEvent, managedVideo = false, playbackEnabled = true, sourceStream = null }: Options) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const homeRef = useRef<HTMLElement | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const workRef = useRef<HTMLCanvasElement | null>(null);
  const webRtcRef = useRef<ReturnType<typeof openCameraWebRtc> | null>(null);
  const fireStateRef = useRef(createFireState());
  const prevFrameRef = useRef<ImageData | null>(null);
  const busyRef = useRef(false);
  const analysisRevisionRef = useRef(0);
  const faceAnalysisRevisionRef = useRef<number | null>(null);
  const analysisActiveRef = useRef(camera.enabled && camera.aiEnabled);
  analysisActiveRef.current = camera.enabled && camera.aiEnabled;
  const lastAudioRef = useRef<string | undefined>(undefined);
  const lastShownRef = useRef<string>('');
  const clearTimerRef = useRef<number | undefined>(undefined);
  const recentDistressFaceRef = useRef<DistressFaceSignal | null>(null);
  const recentDistressSpeechRef = useRef<DistressSpeechSignal | null>(null);
  const recentFireVisualRef = useRef<FireVisualSignal | null>(null);
  const recentSunogRef = useRef<SunogSignal | null>(null);

  const cooldownRef = useRef<Record<string, number>>({});
  const retryRef = useRef(0);
  const runtimeRef = useRef<CameraRuntime>(emptyRuntime(camera.id));

  const [runtime, setRuntime] = useState<CameraRuntime>(() => emptyRuntime(camera.id));
  const [nonce, setNonce] = useState(0);
  const [preview, setPreview] = useState<{ image: string; timestamp: number } | null>(null);
  const latestPreviewRef = useRef<string | undefined>(undefined);
  const face = useFaceDistress(camera.enabled && camera.aiEnabled);
  const analyzeFace = face.analyze;
  const streamUrl = hlsUrlFor(camera, settings);

  // Visible camera cards share this player only while the live page is open.
  // Dashboard snapshots and background audio never create a video element.
  useEffect(() => {
    if (!managedVideo || !playbackEnabled || !camera.enabled) return;
    const home = document.createElement('div');
    home.setAttribute('aria-hidden', 'true');
    home.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;overflow:hidden;pointer-events:none;';
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.crossOrigin = 'anonymous';
    home.appendChild(video);
    document.body.appendChild(home);
    videoRef.current = video;
    homeRef.current = home;
    return () => {
      video.pause();
      video.removeAttribute('src');
      video.srcObject = null;
      video.load();
      video.remove();
      home.remove();
      if (videoRef.current === video) videoRef.current = null;
      if (homeRef.current === home) homeRef.current = null;
    };
  }, [managedVideo, playbackEnabled, camera.enabled]);

  const patch = useCallback((p: Partial<CameraRuntime>) => {
    runtimeRef.current = { ...runtimeRef.current, ...p };
    setRuntime(runtimeRef.current);
  }, []);

  // Work already awaiting a detector must not publish after its camera, AI
  // switch, source, or thresholds change. Audio retains its separate lifecycle.
  useEffect(() => {
    analysisRevisionRef.current += 1;
    faceAnalysisRevisionRef.current = null;
    if (!camera.enabled || !camera.aiEnabled) {
      prevFrameRef.current = null;
      fireStateRef.current = createFireState();
      recentDistressFaceRef.current = null;
      recentFireVisualRef.current = null;
      recentSunogRef.current = null;
      patch({
        objects: [], humanCount: 0, saliencyScore: 0, attentionScore: 0,
        fire: { detected: false, candidate: false, confidence: 0 },
        smoke: { detected: false, confidence: 0 },
        faceDistress: { detected: false, label: '', confidence: 0 },
      });
    }
    return () => { analysisRevisionRef.current += 1; };
  }, [camera.enabled, camera.aiEnabled, camera.id, sourceStream, playbackEnabled, settings.objectThreshold, settings.fireThreshold, settings.saliencyThreshold, settings.priorityObjects, patch]);

  /** Newest Whisper sentence replaces the old one and clears after 5 s. */
  const showTranscript = useCallback((text: string) => {
    patch({ transcript: text });
    if (clearTimerRef.current) window.clearTimeout(clearTimerRef.current);
    clearTimerRef.current = window.setTimeout(() => patch({ transcript: '' }), TRANSCRIPT_CLEAR_MS);
  }, [patch]);

  useEffect(() => () => { if (clearTimerRef.current) window.clearTimeout(clearTimerRef.current); }, []);

  const snapshot = useCallback(() => {
    const live = captureVideoSnapshot(videoRef.current);
    if (live) return live;
    if (latestPreviewRef.current) return latestPreviewRef.current;
    const c = workRef.current;
    try { if (c) return c.toDataURL('image/jpeg', 0.65); } catch { /* use the last camera still */ }
    return captureCameraEventSnapshot(camera.id);
  }, [camera.id]);

  const emit = useCallback(
    (type: DetectionEvent['type'], label: string, confidence: number) => {
      const now = Date.now();
      const key = type === 'fire' ? 'fire' : `${type}:${label}`;
      if (cooldownRef.current[key] && now - cooldownRef.current[key] < 15000) return;
      cooldownRef.current[key] = now;
      runtimeRef.current.alerts += 1;
      onEventRef.current?.({
        cameraId: camera.id,
        cameraName: camera.name,
        location: camera.location,
        type,
        label,
        confidence,
        timestamp: new Date().toISOString(),
        snapshot: snapshot(),
      });
    },
    [camera.id, camera.name, camera.location, snapshot],
  );

  const maybeEmitVerifiedDistress = useCallback(() => {
    const verified = fuseDistressSignals(recentDistressFaceRef.current, recentDistressSpeechRef.current);
    if (!verified) return false;
    // Consume both signals so one spoken phrase cannot repeatedly combine with
    // subsequent face frames. The normal event cooldown adds a second guard.
    recentDistressFaceRef.current = null;
    recentDistressSpeechRef.current = null;
    emit('multimodal-distress', multimodalDistressLabel(verified), verified.confidence);
    return true;
  }, [emit]);

  const maybeEmitVerifiedFire = useCallback(() => {
    const verified = fuseFireWithSunog(recentFireVisualRef.current, recentSunogRef.current);
    if (!verified) return false;
    recentFireVisualRef.current = null;
    recentSunogRef.current = null;
    emit('fire', fireSpeechLabel(), verified.confidence);
    return true;
  }, [emit]);

  // Keep camera playback realtime; retry WebRTC rather than downgrading to HLS.
  const whepUrl = webrtcUrlFor(camera, settings);

  useEffect(() => {
    if (!camera.enabled) {
      patch({ status: 'offline', error: null, fps: 0 });
      return;
    }
    if (!playbackEnabled) {
      if (runtimeRef.current.fps !== 0) patch({ fps: 0 });
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;
    let retryTimer: number | undefined;
    let firstFrameTimer: number | undefined;
    let frameCallback: number | undefined;
    let sourceRevision = 0;
    let lastProgressAt = Date.now();
    let hasFrame = false;
    const counter = createPlaybackFrameCounter(video);
    const resetProgress = () => {
      sourceRevision += 1;
      lastProgressAt = Date.now();
      hasFrame = false;
      counter.reset();
    };
    patch({ status: 'connecting', error: null, fps: 0, playbackWarning: null });
    const ready = () => {
      if (cancelled || retryTimer !== undefined || runtimeRef.current.error === 'Playback blocked'
        || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
      window.clearTimeout(firstFrameTimer);
      firstFrameTimer = undefined;
      lastProgressAt = Date.now();
      hasFrame = true;
      retryRef.current = 0;
      if (runtimeRef.current.status !== 'online' || runtimeRef.current.error || runtimeRef.current.playbackWarning) {
        patch({ status: 'online', error: null, playbackWarning: null });
      }
    };
    video.addEventListener('loadeddata', ready);
    video.addEventListener('playing', ready);

    const play = () => {
      const revision = sourceRevision;
      void video.play().catch(error => {
        if (!cancelled && revision === sourceRevision && error?.name !== 'AbortError') {
          patch({ status: 'error', error: 'Playback blocked', fps: 0 });
        }
      });
    };

    function scheduleWebRtcRetry(message: string) {
      if (cancelled || retryTimer !== undefined) return;
      window.clearTimeout(firstFrameTimer);
      firstFrameTimer = undefined;
      webRtcRef.current?.close();
      webRtcRef.current = null;
      retryRef.current += 1;
      patch({
        status: 'connecting',
        error: null,
        fps: 0,
        transport: 'webrtc',
        playbackWarning: message,
      });
      retryTimer = window.setTimeout(startWebRtc, Math.min(5000, 1000 * retryRef.current));
    }

    function startWebRtc() {
      if (cancelled) return;
      window.clearTimeout(retryTimer);
      retryTimer = undefined;
      if (typeof RTCPeerConnection !== 'function') {
        patch({ status: 'error', error: 'Realtime playback is not supported in this browser.', fps: 0, transport: 'webrtc' });
        return;
      }
      resetProgress();
      patch({ status: 'connecting', error: null, fps: 0, transport: 'webrtc' });
      firstFrameTimer = window.setTimeout(
        () => scheduleWebRtcRetry('Realtime camera did not start. Retrying…'),
        PLAYBACK_STALL_MS,
      );
      try {
        webRtcRef.current = openCameraWebRtc(whepUrl, {
          onStream: stream => {
            if (cancelled) return;
            if (video.srcObject !== stream) video.srcObject = stream;
            play();
          },
          onError: error => {
            const accessDenied = /HTTP (401|403)\b/.test(error.message);
            const advice = accessDenied
              ? 'Check MediaMTX authentication and read permission for this stream.'
              : 'Check bridge reachability and firewall access to TCP 8889 and UDP/TCP 8189.';
            scheduleWebRtcRetry(`Realtime connection failed: ${error.message} ${advice} Retrying…`);
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        scheduleWebRtcRetry(`Unable to start realtime playback: ${message} Retrying…`);
      }
    }

    const countFrame: VideoFrameRequestCallback = (_now, metadata) => {
      if (cancelled) return;
      counter.countPresentedFrame(metadata);
      frameCallback = video.requestVideoFrameCallback(countFrame);
    };
    if (video.requestVideoFrameCallback) frameCallback = video.requestVideoFrameCallback(countFrame);
    const playbackTimer = window.setInterval(() => {
      if (cancelled) return;
      const measured = counter.sample();
      if (measured.advanced) ready();
      const fps = runtimeRef.current.status === 'online' ? measured.fps : 0;
      if (runtimeRef.current.fps !== fps) patch({ fps });
      if (runtimeRef.current.status === 'error' || retryTimer !== undefined) return;
      if (hasFrame && Date.now() - lastProgressAt >= PLAYBACK_STALL_MS) {
        scheduleWebRtcRetry('Realtime video stalled. Reconnecting…');
      }
    }, 1000);

    if (sourceStream) {
      patch({ transport: 'local' });
      video.srcObject = sourceStream;
      video.play().then(() => { if (!cancelled && video.readyState >= 2) ready(); }).catch(() => {
        if (!cancelled) patch({ status: 'error', error: 'Playback blocked' });
      });
    } else startWebRtc();
    return () => {
      cancelled = true;
      window.clearTimeout(retryTimer);
      window.clearTimeout(firstFrameTimer);
      window.clearInterval(playbackTimer);
      if (frameCallback !== undefined) video.cancelVideoFrameCallback(frameCallback);
      video.removeEventListener('loadeddata', ready);
      video.removeEventListener('playing', ready);
      webRtcRef.current?.close();
      webRtcRef.current = null;
      video.pause(); video.removeAttribute('src'); video.srcObject = null; video.load();
    };
  }, [whepUrl, camera.enabled, managedVideo, playbackEnabled, sourceStream, nonce, patch]);

  // ---- Shared analysis of live frames and lightweight still snapshots -----
  const drawWorkFrame = useCallback((source: CanvasImageSource, width: number, height: number) => {
    const canvas = workRef.current ?? (workRef.current = document.createElement('canvas'));
    const w = Math.min(320, width);
    const h = Math.max(1, Math.round(height / width * w));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(source, 0, 0, w, h);
    return { canvas, frame: ctx.getImageData(0, 0, w, h) };
  }, []);

  const analyzeFrame = useCallback(async (
    source: CanvasImageSource,
    width: number,
    height: number,
    isStopped: () => boolean,
  ) => {
    if (!camera.enabled || isStopped() || busyRef.current) return;
    const revision = analysisRevisionRef.current;
    const cancelled = () => isStopped()
      || revision !== analysisRevisionRef.current || !analysisActiveRef.current;
    busyRef.current = true;
    const started = performance.now();
    try {
      const drawn = drawWorkFrame(source, width, height);
      if (!drawn) return;
      if (!camera.aiEnabled || cancelled()) return;
      const { canvas, frame } = drawn;
      // Objects + humans
      const objects = await detectObjects(canvas, settings.objectThreshold);
      if (cancelled()) return;
      const humanCount = objects.filter(o => HUMAN_LABELS.has(o.label)).length;

      const sal = computeSaliency(frame, prevFrameRef.current, 'sobel', settings.saliencyThreshold ?? 40);
      prevFrameRef.current = frame;
      const saliencyScore = computeSaliencyScore(sal);
      const objectScore = objects.length > 0
        ? Math.max(...objects.map(object => object.confidence * 100)) : 0;
      const audioScore = runtimeRef.current.audioDistress.detected
        ? runtimeRef.current.audioDistress.confidence * 100 : 0;
      const attentionScore = Math.min(100, Math.round(
        0.5 * saliencyScore + 0.3 * objectScore + 0.2 * audioScore,
      ));
      const fire = detectFire(frame, fireStateRef.current, objects);
      const fireObservedAt = Date.now();

      // A flame-like region identified as content on a TV/phone/laptop must
      // invalidate both halves of fire fusion. This prevents an earlier visual
      // candidate or a recently spoken "sunog" from verifying screen content.
      if (fire.screenSuppressed) {
        recentFireVisualRef.current = null;
        recentSunogRef.current = null;
      }

      const fireVisual = makeFireVisualSignal(
        !fire.screenSuppressed && fire.fireCandidate,
        fire.confidence,
        fire.firePixelRatio,
        fire.smokeRatio,
        fire.visibility,
        fireObservedAt,
      );

      faceAnalysisRevisionRef.current = revision;
      await analyzeFace(canvas);
      if (cancelled()) return;

      // Publish fusion only after this frame is still confirmed current. Speech
      // may have arrived while face analysis was running; storing it first and
      // checking here makes either signal order work without stale-frame alerts.
      if (fireVisual) recentFireVisualRef.current = fireVisual;
      const immediateFireSmoke = isImmediateFireSmoke(fireVisual);
      let verifiedFireSpeech = false;
      if (immediateFireSmoke && fireVisual) {
        recentSunogRef.current = null;
        recentFireVisualRef.current = null;
        emit('fire', fireSmokeLabel(fireVisual), fireVisual.confidence);
      } else if (fireVisual) {
        verifiedFireSpeech = maybeEmitVerifiedFire();
      }

      const previousFire = runtimeRef.current.fire;
      patch({
        objects, humanCount, saliencyScore, attentionScore,
        frameWidth: canvas.width, frameHeight: canvas.height,
        fire: {
          detected: immediateFireSmoke || verifiedFireSpeech
            || (fire.fireDetected && fire.confidence >= settings.fireThreshold),
          candidate: !!fireVisual,
          confidence: fire.confidence,
          candidateConfidence: fireVisual?.confidence ?? previousFire.candidateConfidence,
          firePixelRatio: fire.firePixelRatio,
          smokeRatio: fire.smokeRatio,
          visibility: fire.visibility,
          candidateAt: fireVisual?.at ?? previousFire.candidateAt,
          bbox: fire.smoothedBbox,
        },
        // Smoke can be displayed as a visual condition, but smoke by itself no
        // longer emits an emergency alert. It must corroborate a fire candidate.
        smoke: {
          detected: !fire.screenSuppressed && fire.smokeRatio >= SMOKE_REGION_MIN_RATIO,
          confidence: fire.screenSuppressed ? 0 : fire.smokeRatio,
        },
        lastDetectionAt: new Date().toISOString(),
        detections: runtimeRef.current.detections + objects.length,
        latencyMs: Math.round(performance.now() - started),
      });

      const historyObjects = settings.priorityObjects
        ? objects.filter(object => HUMAN_LABELS.has(object.label) || settings.priorityObjects.includes(object.label))
        : objects;
      for (const object of historyObjects) emit('object', object.label, object.confidence);
      if (humanCount > 0) emit('human', `${humanCount} person(s)`, 0.9);
      if (!immediateFireSmoke && !verifiedFireSpeech
          && fire.fireDetected && fire.confidence >= settings.fireThreshold) {
        emit('fire', 'Fire detected', fire.confidence);
      }
      if (saliencyScore > 70) emit('saliency', `High saliency (${saliencyScore})`, saliencyScore / 100);
      if (attentionScore > 70) emit('saliency', `High attention (${attentionScore})`, attentionScore / 100);
    } catch {
      // A detector failure does not interrupt previews, playback, or audio.
    } finally {
      busyRef.current = false;
    }
  }, [camera.enabled, camera.aiEnabled, settings.objectThreshold, settings.fireThreshold, settings.saliencyThreshold, settings.priorityObjects, analyzeFace, drawWorkFrame, patch, emit, maybeEmitVerifiedFire]);
  const analyzeFrameRef = useRef(analyzeFrame);
  analyzeFrameRef.current = analyzeFrame;

  useEffect(() => {
    if (!camera.enabled || !camera.aiEnabled) return;
    void loadDetector().catch(() => {});
  }, [camera.enabled, camera.aiEnabled]);

  // Decode only a JPEG every three seconds on the dashboard. This leaves the
  // backend's audio listener active without a browser video connection.
  useEffect(() => {
    if (!camera.enabled || playbackEnabled) return;
    let stopped = false;
    let inFlight = false;
    let request: AbortController | null = null;
    const canvas = document.createElement('canvas');
    const Capture = (window as Window & { ImageCapture?: ImageCaptureConstructor }).ImageCapture;
    const track = sourceStream?.getVideoTracks()[0];
    let capture: FrameCapture | null = null;
    try {
      if (track && Capture) capture = new Capture(track);
    } catch (error) {
      patch({ status: 'error', error: error instanceof Error ? error.message : 'Unable to capture webcam snapshots.' });
      return;
    }
    if (sourceStream && !capture) {
      patch({ status: 'error', error: 'Still previews are unavailable for this webcam in this browser. Open Cameras for live video.' });
      return;
    }
    patch({ status: 'connecting', error: null, fps: 0 });
    const tick = async () => {
      if (stopped || inFlight) return;
      inFlight = true;
      let decoded: Awaited<ReturnType<typeof decodeSnapshot>> | null = null;
      try {
        let timestamp: number;
        if (capture) {
          const image = await capture.grabFrame();
          decoded = { image, width: image.width, height: image.height, close: () => image.close() };
          timestamp = Date.now();
        } else {
          request = new AbortController();
          const result = await getCameraSnapshot(settings.pythonServer, camera.id, request.signal);
          if (stopped) return;
          decoded = await decodeSnapshot(result.blob, request.signal);
          timestamp = result.timestamp;
        }
        if (stopped) return;
        if (!decoded.width || !decoded.height) throw new Error('Camera snapshot is empty.');
        const w = Math.min(640, decoded.width);
        const h = Math.max(1, Math.round(w * decoded.height / decoded.width));
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Unable to display camera snapshot.');
        ctx.drawImage(decoded.image, 0, 0, w, h);
        const image = canvas.toDataURL('image/jpeg', 0.65);
        latestPreviewRef.current = image;
        setPreview({ image, timestamp });
        patch({ status: 'online', error: null, fps: 0 });
        // Keep a durable still for audio-triggered event snapshots even when AI
        // is disabled. Never alter a canvas while its detector is reading it.
        // The analyzer copies pixels synchronously before its first await. Let
        // a slow model finish independently so still previews keep refreshing,
        // and release the decoded full-size bitmap as soon as it is copied.
        void analyzeFrameRef.current(decoded.image, decoded.width, decoded.height, () => stopped);
      } catch (error) {
        if (!stopped) patch({ status: 'error', fps: 0, error: error instanceof Error ? error.message : 'Camera snapshot unavailable.' });
      } finally {
        decoded?.close();
        request = null;
        inFlight = false;
      }
    };
    void tick();
    const id = window.setInterval(tick, SNAPSHOT_INTERVAL_MS);
    return () => { stopped = true; window.clearInterval(id); request?.abort(); };
  }, [camera.enabled, camera.id, playbackEnabled, sourceStream, settings.pythonServer, nonce, patch, drawWorkFrame]);

  // Live frames are processed only while their camera player is visible.
  useEffect(() => {
    if (!camera.enabled || !camera.aiEnabled || !playbackEnabled) return;
    let stopped = false;
    const tick = async () => {
      const video = videoRef.current;
      if (stopped || busyRef.current || !video || video.readyState < 2 || !video.videoWidth) return;
      await analyzeFrameRef.current(video, video.videoWidth, video.videoHeight, () => stopped);
    };
    const id = window.setInterval(tick, 350);
    return () => { stopped = true; window.clearInterval(id); };
  }, [camera.enabled, camera.aiEnabled, playbackEnabled]);

  // Facial expression tracking.
  // Every base expression is non-alerting by itself. Angry/Frightened can
  // verify help/tulong; Frightened/Sad can verify a scream. Happy, Sad, Shock,
  // Neutral and Disgust remain informational Event History entries.
  useEffect(() => {
    if (!camera.enabled || !camera.aiEnabled || faceAnalysisRevisionRef.current !== analysisRevisionRef.current) return;
    const d = face.distress;
    const emotion = historyEmotionMeta(d.expression);
    const fusionExpression = d.hasFace && isMultimodalDistressExpression(d.expression);
    const distressFace = d.hasFace ? makeDistressFaceSignal(d.expression, d.probability) : null;
    const isSadCandidate = distressFace?.label === 'Sad';
    const detected = !!distressFace && !isSadCandidate;

    patch({
      faceDistress: {
        detected,
        label: distressFace?.label ?? d.expression ?? '',
        confidence: distressFace?.confidence ?? d.probability,
      },
    });

    if (d.hasFace && emotion && d.probability >= 0.55) {
      if (emotion.emotion === 'sad' && distressFace) {
        recentDistressFaceRef.current = distressFace;
        maybeEmitVerifiedDistress();
      } else {
        recentDistressFaceRef.current = null;
      }
      emit('emotion', emotion.label, d.probability);
      return;
    }

    if (fusionExpression) {
      if (distressFace) {
        recentDistressFaceRef.current = distressFace;
        maybeEmitVerifiedDistress();
      } else {
        recentDistressFaceRef.current = null;
      }
      return;
    }

    // Neutral, disgust, unknown expressions and no-face states never emit a
    // facial alarm. A clearly observed non-fusion face invalidates the pending
    // visual half; a temporary no-face frame preserves it within the 10 s window.
    if (d.hasFace) recentDistressFaceRef.current = null;
  }, [camera.enabled, camera.aiEnabled, face.distress, patch, emit, maybeEmitVerifiedDistress]);

  // ---- Audio: RTSP audio -> ffmpeg -> Whisper on the backend ---------------
  // The browser never opens a microphone. Listening runs whenever the camera is
  // connected, independently of the AI detection switch.
  useEffect(() => {
    if (sourceStream) {
      patch({ audioListening: false, audioMessage: 'Local microphone listening is managed on the dashboard.', audioTone: 'wait' });
      return;
    }
    if (!camera.enabled) {
      recentDistressSpeechRef.current = null;
      recentSunogRef.current = null;
      lastAudioRef.current = undefined;
      lastShownRef.current = '';
      if (clearTimerRef.current) {
        window.clearTimeout(clearTimerRef.current);
        clearTimerRef.current = undefined;
      }
      latestPreviewRef.current = undefined;
      setPreview(null);
      patch({
        transcript: '',
        audioListening: false,
        audio: null,
        audioDistress: { detected: false, keyword: '', confidence: 0, transcript: '' },
        audioBackendReachable: true,
        audioMessage: 'Connect this camera to start listening.',
        audioTone: 'wait',
      });
      return;
    }
    let stopped = false;
    let inFlight = false;
    patch({ audioListening: true, audioMessage: 'Starting to listen…', audioTone: 'wait' });

    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const { events, status } = await getAudioEvents(
          settings.pythonServer, camera.id, lastAudioRef.current,
        );
        if (stopped) return;
        const described = describeAudioStatus(status, true);
        patch({
          audio: status,
          audioBackendReachable: true,
          audioMessage: described.message,
          audioTone: described.tone,
        });

        // New events are authoritative; when a poll brings none but the backend
        // already holds a transcript we still show it, so the panel is never
        // stuck on "no speech yet" while the backend has words.
        const fresh = events ?? [];
        if (fresh.length) {
          lastAudioRef.current = fresh[fresh.length - 1].timestamp;
          const spoken = fresh.map(e => e.transcript).filter(Boolean).join(' ').trim();
          if (spoken && spoken !== lastShownRef.current) {
            lastShownRef.current = spoken;
            showTranscript(spoken);
          }
          for (const e of fresh) {
            // Backend keyword list OR the full Tagalog/English safety library.
            const safety = matchWakeWord(e.transcript || '');
            const keyword = safety.matched ? safety.phrase : e.keyword;
            const confidence = Math.max(e.confidence || 0, safety.matched ? safety.confidence : 0);
            if (!keyword || confidence < settings.audioThreshold) continue;
            patch({
              audioDistress: {
                detected: true, keyword, confidence, transcript: e.transcript,
              },
            });

            // "help" and "tulong" are intentionally not standalone alarms.
            // Hold them briefly so either speech-first or face-first ordering can
            // verify the same-camera Angry/Frightened + help/tulong combination.
            const spokenAt = Number.isNaN(Date.parse(e.timestamp)) ? Date.now() : Date.parse(e.timestamp);
            const sourceText = `${e.transcript || ''} ${e.keyword || ''}`;
            let reservedForFusion = false;

            const sunog = makeSunogSignal(sourceText, confidence, spokenAt);
            if (sunog) {
              reservedForFusion = true;
              // Store speech only. Fire verification is performed by the next
              // current visual analysis frame, after device-screen suppression.
              // This prevents an older unsuppressed frame from combining with
              // "sunog" before a TV/phone is recognized on the next frame.
              recentSunogRef.current = sunog;
            }

            const distressSpeech = makeDistressSpeechSignal(sourceText, confidence, spokenAt);
            const distressSound = makeDistressSoundSignal(keyword, confidence, spokenAt);
            const fusionAudio = distressSpeech ?? distressSound;
            if (fusionAudio) {
              reservedForFusion = true;
              recentDistressSpeechRef.current = fusionAudio;
              maybeEmitVerifiedDistress();
            }

            // Reserved fusion cues never become standalone audio alarms.
            if (reservedForFusion) continue;
            emit('audio-distress', `Safety word: "${keyword}"`, confidence);
          }
        } else if (
          status?.last_transcript
          && !runtimeRef.current.transcript
          && status.last_transcript !== lastShownRef.current
        ) {
          lastShownRef.current = status.last_transcript;
          showTranscript(status.last_transcript);
        }
      } catch (err) {
        if (stopped) return;
        const message = err instanceof Error ? err.message : String(err);
        const described = describeAudioStatus(null, false);
        patch({
          audioBackendReachable: false,
          audioMessage: `${described.message} (${message})`,
          audioTone: 'error',
        });
      } finally {
        inFlight = false;
      }
    };

    const id = window.setInterval(poll, 1500);
    void poll();
    return () => { stopped = true; window.clearInterval(id); patch({ audioListening: false }); };
  }, [camera.enabled, camera.id, sourceStream, settings.pythonServer, settings.audioThreshold, patch, emit, maybeEmitVerifiedDistress, maybeEmitVerifiedFire, showTranscript]);


  const reconnect = useCallback(() => {
    webRtcRef.current?.close();
    webRtcRef.current = null;
    retryRef.current = 0;
    patch({ status: 'connecting', error: null });
    setNonce(n => n + 1);
  }, [patch]);

  return { videoRef, homeRef, runtime, reconnect, streamUrl, faceReady: face.ready, preview: preview?.image ?? null, previewTimestamp: preview?.timestamp ?? null };
}
