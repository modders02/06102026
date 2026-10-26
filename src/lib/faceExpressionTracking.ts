import { historyEmotionMeta } from '@/lib/emotionEvents';

/** Lightweight spatial tracking during one monitoring session; no identity recognition. */
export interface FaceBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface FaceExpressionSample {
  bounds: FaceBounds; // normalized video coordinates (0..1)
  expression: string | null;
  confidence: number;
}
export interface FaceExpressionTrack {
  id: number;
  bounds: FaceBounds;
  lastSeen: number;
  candidate: string | null;
  consecutive: number;
  confirmed: string | null;
}
export interface FaceTrackingState {
  nextId: number;
  tracks: FaceExpressionTrack[];
}
export interface StableFaceExpression {
  trackId: number;
  /** Left-to-right ordinal in the current camera frame, not a lifetime ID. */
  faceNumber: number;
  label: string;
  confidence: number;
  bounds: FaceBounds;
}
export const FACE_EXPRESSION_STABLE_FRAMES = 3;
export const FACE_EXPRESSION_TRACK_TIMEOUT_MS = 6000;
export const FACE_EXPRESSION_CONFIDENCE = 0.70;
export const NEUTRAL_EXPRESSION_CONFIDENCE = 0.80;

export function emptyFaceTrackingState(): FaceTrackingState {
  return { nextId: 1, tracks: [] };
}

function overlap(a: FaceBounds, b: FaceBounds): number {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const intersection = width * height;
  const union = a.width * a.height + b.width * b.height - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * IoU alone fails when a face is tilted, moves closer, or turns sideways.
 * Spatial distance is measured in units of average face size. This is a
 * session-local association only; it cannot recognize identity.
 */
function spatialMatch(a: FaceBounds, b: FaceBounds): number {
  const iou = overlap(a, b);
  if (iou >= 0.12) return 1 + iou;
  const centerAx = a.x + a.width / 2, centerAy = a.y + a.height / 2;
  const centerBx = b.x + b.width / 2, centerBy = b.y + b.height / 2;
  const avgWidth = (a.width + b.width) / 2;
  const avgHeight = (a.height + b.height) / 2;
  const dx = Math.abs(centerAx - centerBx) / avgWidth;
  const dy = Math.abs(centerAy - centerBy) / avgHeight;
  const scale = Math.max(a.width / b.width, b.width / a.width,
    a.height / b.height, b.height / a.height);
  if (scale > 2.2 || dx > 0.85 || dy > 0.75) return 0;
  return 0.15 + (1 - dx / 0.85) * 0.45 + (1 - dy / 0.75) * 0.25;
}

function plausibleBounds(b: FaceBounds): boolean {
  return [b.x, b.y, b.width, b.height].every(Number.isFinite)
    && b.width > 0.025 && b.height > 0.04
    && b.x >= -0.02 && b.y >= -0.02
    && b.x + b.width <= 1.02 && b.y + b.height <= 1.02;
}

/**
 * Match the current frame's faces spatially, then publish a label only after
 * repeated agreement from the same face. A transient expression change is
 * ignored. ID numbers are volatile within a live session, not biometrics.
 */
export function updateFaceExpressionTracks(
  state: FaceTrackingState,
  samples: readonly FaceExpressionSample[],
  now: number,
): { state: FaceTrackingState; events: StableFaceExpression[] } {
  const previous = state.tracks.filter(track =>
    now >= track.lastSeen && now - track.lastSeen <= FACE_EXPRESSION_TRACK_TIMEOUT_MS);
  const remaining = new Set(previous.map(track => track.id));
  const nextTracks: FaceExpressionTrack[] = [];
  const events: StableFaceExpression[] = [];
  let nextId = state.nextId;

  // Stable presentation order, independent of the detector's output order.
  const ordered = samples.slice(0, 5)
    .filter(sample => plausibleBounds(sample.bounds))
    .sort((a, b) => a.bounds.x - b.bounds.x);
  for (const [ordinal, sample] of ordered.entries()) {
    let match: FaceExpressionTrack | undefined;
    let bestScore = 0.12;
    for (const track of previous) {
      if (!remaining.has(track.id)) continue;
      const score = spatialMatch(track.bounds, sample.bounds);
      if (score > bestScore) { bestScore = score; match = track; }
    }
    if (match) remaining.delete(match.id);
    const old = match ?? {
      id: nextId++, bounds: sample.bounds, lastSeen: now,
      candidate: null, consecutive: 0, confirmed: null,
    };
    const meta = historyEmotionMeta(sample.expression);
    const threshold = meta?.emotion === 'neutral'
      ? NEUTRAL_EXPRESSION_CONFIDENCE : FACE_EXPRESSION_CONFIDENCE;
    const accepted = meta && Number.isFinite(sample.confidence)
      && sample.confidence >= threshold && sample.confidence <= 1
      ? meta.label : null;
    const candidate = accepted;
    const consecutive = candidate
      ? (old.candidate === candidate ? old.consecutive + 1 : 1) : 0;
    const confirmed = candidate && consecutive >= FACE_EXPRESSION_STABLE_FRAMES
      ? candidate : old.confirmed;
    if (confirmed && confirmed !== old.confirmed) {
      events.push({
        trackId: old.id,
        faceNumber: ordinal + 1,
        label: confirmed,
        confidence: sample.confidence,
        bounds: sample.bounds,
      });
    }
    nextTracks.push({
      id: old.id, bounds: sample.bounds, lastSeen: now,
      candidate, consecutive, confirmed,
    });
  }
  // Keep recently occluded tracks for reassociation, without inventing events.
  for (const track of previous) if (remaining.has(track.id)) nextTracks.push(track);
  return { state: { nextId, tracks: nextTracks }, events };
}
