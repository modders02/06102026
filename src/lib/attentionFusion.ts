import type { AudioEventType, DetectedObject } from '@/types/dashboard';

export const FUSION_WEIGHTS = Object.freeze({
  visual: 0.4,
  audio: 0.3,
  object: 0.3,
});

export const DEFAULT_ATTENTION_THRESHOLD = 15;

const clamp100 = (value: number) =>
  Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));

/** Convert microphone dBFS (-60..0) to the study's normalized 0..100 audio score. */
export function audioIntensityScoreFromDb(db: number): number {
  const bounded = Math.max(-60, Math.min(0, Number.isFinite(db) ? db : -60));
  return Math.round(((bounded + 60) / 60) * 100);
}

/** Convert normalized 16-bit PCM RMS (0..1) to the study's 0..100 audio score. */
export function audioIntensityScoreFromRms(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) return 0;
  return audioIntensityScoreFromDb(20 * Math.log10(Math.max(rms, 1e-6)));
}

/**
 * Audio-event bonus from the Chapter III algorithm. The event score is not an
 * alarm by itself; it is one component of the multimodal attention score.
 */
export function audioEventScore(event: AudioEventType, intensityScore = 0): number {
  const eventFloor =
    event === 'bang' || event === 'clap' || event === 'scream' ? 20
      : event === 'speech' ? 10
        : 0;
  return clamp100(Math.max(eventFloor, intensityScore));
}

/**
 * Oweight(t): sum confidence for user-selected priority objects, clipped to the
 * same 0..100 scale as saliency and audio.
 */
export function objectRelevanceScore(
  objects: DetectedObject[],
  priorityObjects: readonly string[] | undefined,
): number {
  if (!priorityObjects?.length || !objects.length) return 0;
  const priority = new Set(priorityObjects);
  const score = objects.reduce(
    (sum, object) => priority.has(object.label)
      ? sum + Math.max(0, Math.min(1, object.confidence)) * 100
      : sum,
    0,
  );
  return Math.round(clamp100(score));
}

/** α(t) = 0.4*S(t) + 0.3*A(t) + 0.3*Oweight(t). */
export function computeAttentionScore(
  visualSaliency: number,
  audioScore: number,
  objectScore: number,
): number {
  return Math.round(clamp100(
    FUSION_WEIGHTS.visual * clamp100(visualSaliency)
    + FUSION_WEIGHTS.audio * clamp100(audioScore)
    + FUSION_WEIGHTS.object * clamp100(objectScore),
  ));
}
