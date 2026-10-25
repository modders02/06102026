/** History-only facial expression edge detection.
 *
 * Facial expression confidence comes from face-api's classifier, not MediaPipe
 * landmarks, and is not a measure of a person's actual emotional state.
 * This feature must never contribute to Camera Alert validation.
 */
export const HAPPY_HISTORY_MIN_CONFIDENCE = 0.80;
export const HAPPY_HISTORY_MIN_CONSECUTIVE_FRAMES = 2;

export interface HappyHistoryState {
  consecutive: number;
  active: boolean;
}

export const freshHappyHistoryState = (): HappyHistoryState => ({
  consecutive: 0,
  active: false,
});

export interface ExpressionFrame {
  hasFace: boolean;
  expression: string | null;
  probability: number;
}

/** Emits once when a strong Happy *classifier label* first stabilizes.
 * No face, neutral, or weak labels reset the sequence. No timer, network
 * access, or actual emotional-state inference is involved.
 */
export function advanceHappyHistory(
  state: HappyHistoryState,
  sample: ExpressionFrame,
): { state: HappyHistoryState; emit: boolean } {
  const confidentHappy = sample.hasFace
    && sample.expression?.trim().toLowerCase() === 'happy'
    && Number.isFinite(sample.probability)
    && sample.probability >= HAPPY_HISTORY_MIN_CONFIDENCE
    && sample.probability <= 1;
  if (!confidentHappy) return { state: freshHappyHistoryState(), emit: false };

  const consecutive = Math.min(
    HAPPY_HISTORY_MIN_CONSECUTIVE_FRAMES,
    state.consecutive + 1,
  );
  const emit = !state.active && consecutive >= HAPPY_HISTORY_MIN_CONSECUTIVE_FRAMES;
  return {
    state: { consecutive, active: state.active || emit },
    emit,
  };
}
