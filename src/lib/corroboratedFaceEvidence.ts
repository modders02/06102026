import { historyEmotionMeta } from '@/lib/emotionEvents';
import { DISTRESS_FACE_MIN_CONFIDENCE, type DistressFaceSignal } from '@/lib/multimodalDistress';

/**
 * A geometry-corrected "Frightened" history label is not enough by itself
 * to verify an alert. Require two distinct, recent, consistent frames from
 * the facial analyzer AND a confirmed underlying sad/distress classifier cue.
 * A configured accepted keyword is still mandatory at the fusion layer.
 */
export interface GeometryEvidenceState {
  count: number;
  lastObservedAt: number;
}
export const GEOMETRY_FEAR_REQUIRED_FRAMES = 2;
export const GEOMETRY_FEAR_MAX_GAP_MS = 2_500;
export const GEOMETRY_FEAR_MIN_RAW_CONFIDENCE = 0.65;
export const GEOMETRY_FEAR_MIN_DISPLAY_CONFIDENCE = 0.58;

export interface GeometryFaceObservation {
  hasFace: boolean;
  expression: string | null;
  probability: number;
  historyExpression?: string;
  historyConfidence?: number;
  historyGeometryCorrected?: boolean;
}
export const emptyGeometryEvidenceState = (): GeometryEvidenceState => ({
  count: 0, lastObservedAt: 0,
});

export function corroborateGeometryFear(
  observation: GeometryFaceObservation | null | undefined,
  previous: GeometryEvidenceState,
  now: number,
): { state: GeometryEvidenceState; signal: DistressFaceSignal | null } {
  const rawExpression = (observation?.expression ?? '').trim().toLowerCase();
  const corrected = observation?.hasFace === true
    && observation.historyGeometryCorrected === true
    && (rawExpression === 'sad' || rawExpression === 'sadness')
    && Number.isFinite(observation.probability)
    && observation.probability >= GEOMETRY_FEAR_MIN_RAW_CONFIDENCE
    && observation.probability <= 1
    && historyEmotionMeta(observation.historyExpression)?.emotion === 'frightened'
    && Number.isFinite(observation.historyConfidence)
    && (observation.historyConfidence ?? 0) >= GEOMETRY_FEAR_MIN_DISPLAY_CONFIDENCE
    && (observation.historyConfidence ?? 0) <= 1;
  if (!corrected) {
    return { state: emptyGeometryEvidenceState(), signal: null };
  }

  const count = now > previous.lastObservedAt && now - previous.lastObservedAt <= GEOMETRY_FEAR_MAX_GAP_MS
    ? Math.min(previous.count + 1, GEOMETRY_FEAR_REQUIRED_FRAMES)
    : 1;
  const state = { count, lastObservedAt: now };
  if (count < GEOMETRY_FEAR_REQUIRED_FRAMES) return { state, signal: null };
  const confidence = Math.min(0.70, observation!.historyConfidence!);
  return {
    state,
    signal: confidence >= DISTRESS_FACE_MIN_CONFIDENCE
      ? { label: 'Frightened', confidence, at: now } : null,
  };
}
