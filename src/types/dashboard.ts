export type SaliencyMode = 'sobel' | 'laplacian' | 'motion';
export type AlertSeverity = 'low' | 'medium' | 'high' | 'critical';
export type QualityMode = 'HD' | 'SD';

export interface DetectedObject {
  label: string;
  confidence: number;
  bbox: [number, number, number, number]; // x, y, width, height
}

export type AudioEventType = 'speech' | 'clap' | 'scream' | 'bang' | 'none';

export interface AudioFeatures {
  decibel: number;
  speechDetected: boolean;
  pitchEstimate: number;
  waveform: number[];
  audioEvent: AudioEventType;
}

export interface Alert {
  id: string;
  timestamp: Date;
  message: string;
  severity: AlertSeverity;
  cameraId: number;
  snapshotId?: string;
}

export interface CameraState {
  id: number;
  deviceId: string | null;
  label: string;
  fps: number;
  active: boolean;
  stream: MediaStream | null;
  objects: DetectedObject[];
  saliencyScore: number;
}

export interface DashboardState {
  running: boolean;
  cameras: CameraState[];
  audioFeatures: AudioFeatures;
  attentionScore: number;
  alerts: Alert[];
  saliencyMode: SaliencyMode;
  threshold: number;
  showBoundingBoxes: boolean;
  showHeatmap: boolean;
  showAlerts: boolean;
  quality: QualityMode;
  mirror: boolean;
  heatmapOpacity: number;
  simulationMode: boolean;
  priorityObjects: string[];
}

// All 80 COCO-SSD classes
export const DETECTABLE_OBJECTS = [
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat',
  'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench',
  'bird', 'cat', 'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe',
  'backpack', 'umbrella', 'handbag', 'tie', 'suitcase',
  'frisbee', 'skis', 'snowboard', 'sports ball', 'kite', 'baseball bat', 'baseball glove',
  'skateboard', 'surfboard', 'tennis racket',
  'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl',
  'banana', 'apple', 'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake',
  'chair', 'couch', 'potted plant', 'bed', 'dining table', 'toilet',
  'tv', 'laptop', 'mouse', 'remote', 'keyboard', 'cell phone',
  'microwave', 'oven', 'toaster', 'sink', 'refrigerator',
  'book', 'clock', 'vase', 'scissors', 'teddy bear', 'hair drier', 'toothbrush',
] as const;

// Application-visible object whitelist for indoor safety/context monitoring.
// COCO-SSD can classify many more categories, but animals, vehicles, sports,
// outdoor/street items and low-value household clutter are intentionally hidden.
// "remote" is explicitly excluded because it adds noise without useful context.
export const INDOOR_OBJECTS = [
  'person',
  'chair', 'couch', 'bed', 'dining table', 'toilet', 'sink',
  // Screens/electronics are retained for context and fire-on-screen suppression.
  'tv', 'laptop', 'cell phone', 'keyboard', 'mouse',
  // Containers and sharp objects can be relevant to indoor safety/context.
  'bottle', 'cup', 'bowl', 'knife', 'scissors',
  // Kitchen appliances are relevant to indoor hazard context.
  'microwave', 'oven', 'toaster', 'refrigerator',
  // Bags/luggage can be useful indoor context without enabling outdoor classes.
  'backpack', 'handbag', 'suitcase',
] as const;

const RELEVANT_INDOOR_OBJECTS = new Set<string>(INDOOR_OBJECTS);

export function isRelevantIndoorObject(label: string | null | undefined): boolean {
  return RELEVANT_INDOOR_OBJECTS.has((label ?? '').trim().toLowerCase());
}

export const DEFAULT_PRIORITY_OBJECTS = [
  'person',
  'chair', 'couch', 'bed', 'dining table',
  'bottle', 'cup', 'bowl', 'knife', 'scissors',
  'microwave', 'oven', 'toaster', 'refrigerator',
  // Screens stay available because fire-inside-TV/phone must be suppressible.
  'tv', 'cell phone', 'laptop',
];
