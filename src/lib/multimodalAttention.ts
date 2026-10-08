/**
 * Multimodal attention formula specified in the thesis Scope/Methods.
 *
 * alpha(t) = 0.4 * visual + 0.3 * audio + 0.3 * object
 * All component inputs and the returned score use a 0..100 scale.
 */
export const ATTENTION_WEIGHTS = {
  visual: 0.4,
  audio: 0.3,
  object: 0.3,
} as const;

export const DEFAULT_ATTENTION_THRESHOLD = 15;

const clamp100 = (value: number) =>
  Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));

export interface AttentionInputs {
  visual: number;
  audio: number;
  object: number;
}

export function computeMultimodalAttention({
  visual,
  audio,
  object,
}: AttentionInputs): number {
  const score =
    ATTENTION_WEIGHTS.visual * clamp100(visual)
    + ATTENTION_WEIGHTS.audio * clamp100(audio)
    + ATTENTION_WEIGHTS.object * clamp100(object);
  return Math.round(clamp100(score));
}
