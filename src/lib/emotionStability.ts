/** Pure temporal confirmation for expression labels in Event History only.
 * A model's estimate is not proof of a person's emotional state.
 */
export interface EmotionStabilityState {
  candidate: string | null;
  count: number;
  lastAt: number;
  source: string | null;
  accepted: string | null;
  acceptedConfidence: number;
  acceptedAt: number;
}

export const EMOTION_HISTORY_MIN_CONFIDENCE = 0.66;
export const EMOTION_HISTORY_MIN_MARGIN = 0.10;
export const EMOTION_HISTORY_REQUIRED_FRAMES = 3;
export const EMOTION_HISTORY_MAX_FRAME_GAP_MS = 2600;
export const EMOTION_HISTORY_MAX_STALE_MS = 4200;

export const emptyEmotionStability = (): EmotionStabilityState => ({
  candidate: null, count: 0, lastAt: 0, source: null,
  accepted: null, acceptedConfidence: 0, acceptedAt: 0,
});

export function advanceEmotionStability(
  state: EmotionStabilityState,
  observation: { label: string; confidence: number; runnerUp: number; source: string; at: number } | null,
): EmotionStabilityState {
  if (!observation) return emptyEmotionStability();
  const { label, confidence, runnerUp, source, at } = observation;
  if (!Number.isFinite(at) || !Number.isFinite(confidence) || !Number.isFinite(runnerUp)
      || !label || !source || confidence < 0 || confidence > 1
      || runnerUp < 0 || runnerUp > 1) return emptyEmotionStability();
  const sameSource = state.source === source;
  const continuous = sameSource && at > state.lastAt
    && at - state.lastAt <= EMOTION_HISTORY_MAX_FRAME_GAP_MS;
  const eligible = confidence >= EMOTION_HISTORY_MIN_CONFIDENCE
    && confidence - runnerUp >= EMOTION_HISTORY_MIN_MARGIN;
  const candidate = eligible ? label : null;
  const count = candidate
    ? (continuous && candidate === state.candidate ? state.count + 1 : 1) : 0;
  const approved = candidate !== null && count >= EMOTION_HISTORY_REQUIRED_FRAMES;
  const previousFresh = continuous && at - state.acceptedAt <= EMOTION_HISTORY_MAX_STALE_MS;
  return {
    candidate, count, lastAt: at, source,
    accepted: approved ? label : previousFresh ? state.accepted : null,
    acceptedConfidence: approved ? confidence
      : previousFresh ? state.acceptedConfidence : 0,
    acceptedAt: approved ? at : previousFresh ? state.acceptedAt : 0,
  };
}

/** Safety face-api evidence also requires two consecutive fresh matching
 * frames; independent of FER history (FER cannot grant safety alerts).
 */
export interface DistressConfirmation {
  label: string | null;
  count: number;
  lastAt: number;
}

export const emptyDistressConfirmation = (): DistressConfirmation => ({
  label: null, count: 0, lastAt: 0,
});

export function advanceDistressConfirmation(
  previous: DistressConfirmation,
  label: string | null,
  confidence: number,
  at: number,
): DistressConfirmation {
  if (!label || !Number.isFinite(confidence) || confidence < 0.55 || !Number.isFinite(at))
    return emptyDistressConfirmation();
  const within = at > previous.lastAt && at - previous.lastAt <= 2500;
  return {
    label,
    count: within && previous.label === label ? Math.min(2, previous.count + 1) : 1,
    lastAt: at,
  };
}
