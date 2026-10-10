import type { DetectedObject } from '@/types/dashboard';
import { computeSaliency, computeSaliencyScore } from '@/lib/saliency';

export type MotionAnomalyKind = 'person-collapse' | 'object-fall' | 'rapid-motion';

export interface MotionAnomalyResult {
  detected: boolean;
  kind: MotionAnomalyKind | null;
  label: string;
  confidence: number;
  motionScore: number;
  activeRatio: number;
}

export interface MotionAnomalyState {
  previousObjects: DetectedObject[];
  pendingKind: MotionAnomalyKind | null;
  pendingLabel: string;
  consecutiveFrames: number;
}

export function createMotionAnomalyState(): MotionAnomalyState {
  return {
    previousObjects: [],
    pendingKind: null,
    pendingLabel: '',
    consecutiveFrames: 0,
  };
}

const center = (box: DetectedObject['bbox']) => ({
  x: box[0] + box[2] / 2,
  y: box[1] + box[3] / 2,
});

function nearestPrevious(
  current: DetectedObject,
  previous: DetectedObject[],
  width: number,
  height: number,
) {
  const c = center(current.bbox);
  let best: DetectedObject | null = null;
  let bestDistance = Infinity;
  for (const candidate of previous) {
    if (candidate.label !== current.label) continue;
    const p = center(candidate.bbox);
    const dx = (c.x - p.x) / Math.max(1, width);
    const dy = (c.y - p.y) / Math.max(1, height);
    const distance = Math.hypot(dx, dy);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  // Allow substantial downward travel while still rejecting unrelated tracks.
  // The semantic fall validator separately constrains horizontal displacement.
  return bestDistance <= 0.4 ? best : null;
}

function activePixelRatio(map: ImageData) {
  let active = 0;
  let total = 0;
  for (let i = 0; i < map.data.length; i += 4) {
    total += 1;
    if (map.data[i] > 0) active += 1;
  }
  return total ? active / total : 0;
}

/**
 * Conservative temporal anomaly validator. A candidate must persist across two
 * analysis cycles; a single lighting flash or detector jitter never alerts.
 */
export function detectMotionAnomaly(
  currentFrame: ImageData,
  previousFrame: ImageData | null,
  objects: DetectedObject[],
  state: MotionAnomalyState,
): MotionAnomalyResult {
  const none = (motionScore = 0, activeRatio = 0): MotionAnomalyResult => ({
    detected: false,
    kind: null,
    label: '',
    confidence: 0,
    motionScore,
    activeRatio,
  });

  if (!previousFrame
      || previousFrame.width !== currentFrame.width
      || previousFrame.height !== currentFrame.height) {
    state.previousObjects = objects.map(object => ({ ...object, bbox: [...object.bbox] as DetectedObject['bbox'] }));
    state.pendingKind = null;
    state.pendingLabel = '';
    state.consecutiveFrames = 0;
    return none();
  }

  const motionMap = computeSaliency(currentFrame, previousFrame, 'motion', 25);
  // Test doubles or unsupported canvas paths may not produce a map. Treat that
  // cycle as unavailable evidence rather than converting it into an anomaly.
  if (!motionMap?.data) return none();
  const motionScore = computeSaliencyScore(motionMap);
  const activeRatio = activePixelRatio(motionMap);
  const width = currentFrame.width;
  const height = currentFrame.height;

  let kind: MotionAnomalyKind | null = null;
  let label = '';
  let confidence = 0;

  for (const object of objects) {
    const previous = nearestPrevious(object, state.previousObjects, width, height);
    if (!previous) continue;
    const nowCenter = center(object.bbox);
    const oldCenter = center(previous.bbox);
    const down = (nowCenter.y - oldCenter.y) / Math.max(1, height);

    if (object.label === 'person') {
      const oldVertical = previous.bbox[3] / Math.max(1, previous.bbox[2]);
      const nowHorizontal = object.bbox[2] / Math.max(1, object.bbox[3]);
      if (oldVertical >= 1.15 && nowHorizontal >= 1.1 && down >= 0.05) {
        kind = 'person-collapse';
        label = 'Possible person collapse';
        confidence = Math.min(0.98, 0.65 + down * 1.5);
        break;
      }
    } else if (down >= 0.12 && Math.abs(nowCenter.x - oldCenter.x) / Math.max(1, width) <= 0.2) {
      kind = 'object-fall';
      label = `Possible falling object: ${object.label}`;
      confidence = Math.min(0.95, 0.6 + down);
      break;
    }
  }

  if (!kind && activeRatio >= 0.15 && activeRatio <= 0.65 && motionScore >= 6) {
    kind = 'rapid-motion';
    label = 'Rapid unexplained motion';
    confidence = Math.min(0.9, 0.55 + activeRatio);
  }

  if (kind && state.pendingKind === kind && state.pendingLabel === label) {
    state.consecutiveFrames += 1;
  } else if (kind) {
    state.pendingKind = kind;
    state.pendingLabel = label;
    state.consecutiveFrames = 1;
  } else {
    state.pendingKind = null;
    state.pendingLabel = '';
    state.consecutiveFrames = 0;
  }

  state.previousObjects = objects.map(object => ({ ...object, bbox: [...object.bbox] as DetectedObject['bbox'] }));

  // A semantic fall/collapse already has two-source temporal validation:
  // the same tracked object changed geometry/position between consecutive
  // frames. Generic rapid motion has no semantic object evidence, so require
  // persistence across two analysis cycles to reject one-frame light flashes.
  const requiredFrames = kind === 'rapid-motion' ? 2 : 1;
  if (!kind || state.consecutiveFrames < requiredFrames) return none(motionScore, activeRatio);
  return {
    detected: true,
    kind,
    label,
    confidence,
    motionScore,
    activeRatio,
  };
}
