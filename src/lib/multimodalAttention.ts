import type { DetectedObject } from '@/types/dashboard';

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


/** Safety relevance multipliers used by the semantic object term. */
export const OBJECT_PRIORITY_WEIGHTS: Record<string, number> = {
  person: 1.0,
  knife: 1.0,
  scissors: 0.8,
  oven: 0.75,
  toaster: 0.65,
  microwave: 0.55,
  cell_phone: 0.45,
  'cell phone': 0.45,
};

/**
 * Thesis Oweight(t): sum(confidence_i * priority(class_i)), normalized to 0..100.
 * User-selected priority objects receive full weight unless a safety-specific
 * weight above is already defined.
 */
export function computeObjectImportance(
  objects: DetectedObject[],
  priorityObjects: string[] = [],
): number {
  const selected = new Set(priorityObjects);
  let total = 0;
  for (const object of objects) {
    if (selected.size && !selected.has(object.label) && object.label !== 'person') continue;
    const weight = OBJECT_PRIORITY_WEIGHTS[object.label] ?? (selected.has(object.label) ? 1 : 0.5);
    total += clamp100(object.confidence * 100) * weight;
  }
  return Math.round(clamp100(total));
}
