import type { DetectedObject, SaliencyMode } from '@/types/dashboard';
import type { CctvAudioStatus } from '@/lib/multiCamServer';
import { cameraPlaybackUrl } from '@/lib/cameraStreamEndpoints';


export type CameraStatus = 'offline' | 'connecting' | 'online' | 'error';
export type GridLayout = '1x1' | '2x2' | '3x3' | '4x4';
export type StreamQuality = 'auto' | 'high' | 'low';

/** A CCTV camera the user configured. Stored locally (localStorage). */
export interface CameraConfig {
  id: string;
  /** MediaMTX path, e.g. "front" -> http://server:8888/front/index.m3u8 */
  path: string;
  name: string;
  location: string;
  rtspUrl: string;
  /** HLS URL returned by the backend (authoritative). */
  streamUrl?: string;
  /** WHEP endpoint reported by the bridge for realtime playback. */
  webrtcUrl?: string;
  enabled: boolean;
  /** AI detection on/off for this camera (independent pipeline). */
  aiEnabled: boolean;
  recording: boolean;
  createdAt: string;
}

export interface MultiCamSettings {
  mediamtxHost: string;   // e.g. http://127.0.0.1:8888
  pythonServer: string;   // e.g. http://127.0.0.1:5000
  webrtcHost?: string;    // optional override for a custom WebRTC listener
  fireThreshold: number;      // 0..1
  objectThreshold: number;    // 0..1
  saliencyThreshold?: number; // image edge threshold, default 40
  /** User-selectable saliency operator from the Chapter III algorithm. */
  saliencyMode?: SaliencyMode;
  /** Unified attention threshold τ on the normalized 0..100 score. */
  attentionThreshold?: number;
  /** Limit object history to these labels; people are always included. */
  priorityObjects?: string[];
  audioThreshold: number;     // 0..1
  maxCameras: number;
  gridLayout: GridLayout;
  streamQuality: StreamQuality;
}

export type DetectionType =
  | 'object'
  | 'human'
  | 'fire'
  | 'smoke'
  | 'face-distress'
  | 'audio-distress'
  | 'multimodal-distress'
  | 'emotion'
  | 'saliency'
  | 'motion-anomaly';

export interface DetectionEvent {
  id: string;
  cameraId: string;
  cameraName: string;
  location: string;
  type: DetectionType;
  label: string;
  confidence: number;    // 0..1
  timestamp: string;     // ISO
  snapshot?: string;     // data URL
  /** Object URL of the 10-second emergency clip (this session only). */
  clipUrl?: string;
  /** File name of the clip saved on the user's computer. */
  clipFile?: string;
  /** Recording or saving failure shown with the event. */
  clipError?: string;
}

/** Live, per-camera pipeline state. Never shared between cameras. */
export interface CameraRuntime {
  cameraId: string;
  status: CameraStatus;
  error: string | null;
  fps: number;
  latencyMs: number;
  transport?: 'webrtc' | 'hls' | 'local';
  playbackWarning?: string | null;
  saliencyScore: number;
  /** SOP weighted fusion score: 0.4 visual + 0.3 audio + 0.3 object. */
  attentionScore: number;
  /** Normalized A(t) from the camera microphone RMS/intensity. */
  audioIntensityScore?: number;
  /** Normalized Oweight(t) from configured priority object confidences. */
  objectRelevanceScore?: number;
  /** Validation-layer status for degraded lighting/audio/latency. */
  validation?: {
    ready: boolean;
    visualUsable: boolean;
    audioUsable: boolean;
    objectUsable: boolean;
    flags: string[];
  };
  motionAnomaly?: {
    detected: boolean;
    kind: string | null;
    label: string;
    confidence: number;
    motionScore: number;
    activeRatio: number;
  };
  objects: DetectedObject[];
  /** Coordinate system used for detection boxes. */
  frameWidth?: number;
  frameHeight?: number;
  humanCount: number;
  fire: {
    detected: boolean;
    /** Looser visual candidate used only for corroborated fire fusion. */
    candidate?: boolean;
    confidence: number;
    candidateConfidence?: number;
    firePixelRatio?: number;
    smokeRatio?: number;
    visibility?: number;
    candidateAt?: number;
    bbox?: [number, number, number, number];
  };
  smoke: { detected: boolean; confidence: number };
  faceDistress: { detected: boolean; label: string; confidence: number };
  audioDistress: { detected: boolean; keyword: string; confidence: number; transcript: string };
  /** Rolling live transcription of everything heard on this camera. */
  transcript: string;
  /** True while transcripts are being polled from the backend. */
  audioListening: boolean;
  /** Compact per-camera audio/Whisper diagnostics from the local bridge. */
  audio: CctvAudioStatus | null;
  /** Human-readable reason transcription is (not) producing words. */
  audioMessage: string;
  audioTone: 'ok' | 'wait' | 'error';
  /** False when the local bridge could not be reached on the last poll. */
  audioBackendReachable: boolean;
  lastDetectionAt: string | null;
  detections: number;
  alerts: number;

}

export const DEFAULT_SETTINGS: MultiCamSettings = {
  mediamtxHost: 'http://127.0.0.1:8888',
  pythonServer: 'http://127.0.0.1:5000',
  fireThreshold: 0.55,
  objectThreshold: 0.45,
  audioThreshold: 0.6,
  saliencyMode: 'sobel',
  attentionThreshold: 15,
  maxCameras: 16,
  gridLayout: '2x2',
  streamQuality: 'auto',
};

export function hlsUrlFor(camera: CameraConfig, settings: MultiCamSettings) {
  // Always prefer the HLS URL the backend reported for this camera.
  if (camera.streamUrl?.trim()) return cameraPlaybackUrl(camera.streamUrl, settings.pythonServer);
  const host = settings.mediamtxHost.trim().replace(/\/+$/, '');
  return cameraPlaybackUrl(`${host}/${camera.path.replace(/^\/+|\/+$/g, '')}/index.m3u8`, settings.pythonServer);
}

export function webrtcUrlFor(camera: CameraConfig, settings: MultiCamSettings) {
  if (camera.webrtcUrl?.trim()) return cameraPlaybackUrl(camera.webrtcUrl, settings.pythonServer);
  if (settings.webrtcHost?.trim()) return cameraPlaybackUrl(`${settings.webrtcHost.trim().replace(/\/+$/, '')}/${camera.path.replace(/^\/+|\/+$/g, '')}/whep`, settings.pythonServer);
  const url = new URL(hlsUrlFor(camera, settings));
  url.port = '8889';
  url.pathname = `/${camera.path.replace(/^\/+|\/+$/g, '')}/whep`;
  url.search = '';
  return url.href;
}
