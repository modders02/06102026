import { historyEmotionMeta } from '@/lib/emotionEvents';

/**
 * Event-History-only expression debounce. Camera Alerts and keyword/face
 * fusion always use immediate current-frame evidence, not this history gate.
 * Facial labels are statistical estimates, not verified emotions or identities.
 */
export const EMOTION_STABILITY_MS = 5_000;
export const EMOTION_MIN_STABLE_SAMPLES = 4;
export const EMOTION_MAX_SAMPLE_GAP_MS = 2_800;
export const EMOTION_MIN_CLASS_MARGIN = 0.12;

export interface EmotionHistorySample {
  label: string | null | undefined;
  confidence: number;
  /** Difference between top two expression model probabilities, if known. */
  classMargin?: number;
  /** Geometry-based display correction (never safety/fusion evidence). */
  geometryCorrected?: boolean;
  hasFace: boolean;
}

export interface EmotionHistoryState {
  candidate: string | null;
  since: number;
  lastAt: number;
  samples: number;
  confirmed: string | null;
  confidenceSum: number;
}

export const emptyEmotionHistoryState = (): EmotionHistoryState => ({
  candidate: null, since: 0, lastAt: 0, samples: 0,
  confirmed: null, confidenceSum: 0,
});

export interface StableEmotionEvent {
  label: string;
  confidence: number;
}

/**
 * Only emit when at least four independent frames agree across >=5 seconds.
 * Neutral and Disgust require stronger confidence to avoid rapid noisy logs.
 * A single brief wrong class does not overwrite an already confirmed label.
 */
export function observeEmotionHistory(
  state: EmotionHistoryState,
  sample: EmotionHistorySample,
  now: number,
): { state: EmotionHistoryState; event: StableEmotionEvent | null } {
  const meta = historyEmotionMeta(sample.label);
  const minimum = sample.geometryCorrected
    ? 0.62
    : meta?.emotion === 'neutral' ? 0.82
    : meta?.emotion === 'disgust' ? 0.80
    : 0.72;
  const valid = sample.hasFace && !!meta
    && Number.isFinite(now)
    && Number.isFinite(sample.confidence)
    && sample.confidence >= minimum && sample.confidence <= 1
    && (sample.classMargin === undefined
      || (Number.isFinite(sample.classMargin)
        && sample.classMargin >= EMOTION_MIN_CLASS_MARGIN));

  const gap = now - state.lastAt;
  if (!valid || (state.lastAt > 0 && (gap < 0 || gap > EMOTION_MAX_SAMPLE_GAP_MS))) {
    // Do not publish an old candidate from a disconnected, missed or
    // ambiguous frame. Keep the last stable class to avoid relogging it.
    const cleared = { ...state, candidate: null, since: 0, lastAt: valid ? now : 0,
      samples: 0, confidenceSum: 0 };
    if (!valid) return { state: cleared, event: null };
    state = cleared;
  }

  if (state.candidate !== meta!.label) {
    return {
      state: {
        ...state, candidate: meta!.label, since: now, lastAt: now,
        samples: 1, confidenceSum: sample.confidence,
      },
      event: null,
    };
  }
  if (now <= state.lastAt) return { state, event: null };

  const samples = state.samples + 1;
  const confidenceSum = state.confidenceSum + sample.confidence;
  const next: EmotionHistoryState = {
    ...state, samples, confidenceSum, lastAt: now,
  };
  if (samples < EMOTION_MIN_STABLE_SAMPLES
      || now - state.since < EMOTION_STABILITY_MS
      || state.confirmed === meta!.label) {
    return { state: next, event: null };
  }
  return {
    state: { ...next, confirmed: meta!.label },
    event: {
      label: meta!.label,
      confidence: Math.min(1, Math.max(0, confidenceSum / samples)),
    },
  };
}
