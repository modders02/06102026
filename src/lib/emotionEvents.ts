export type HistoryEmotion =
  | 'happy' | 'sad' | 'angry' | 'frightened' | 'surprised' | 'neutral' | 'disgust';

export type HistoryEmotionLabel =
  | 'Happy' | 'Sad' | 'Angry' | 'Frightened' | 'Surprised' | 'Neutral' | 'Disgust';

export interface HistoryEmotionMeta {
  emotion: HistoryEmotion;
  label: HistoryEmotionLabel;
  icon: string;
  rowClass: string;
  labelClass: string;
}

/** A face-expression observation is informational, not an emergency signal. */
export const HISTORY_EXPRESSION_MIN_CONFIDENCE = 0.55;
export const HISTORY_EXPRESSION_STABLE_FRAMES = 2;

export interface EmotionHistoryTrackerState {
  candidate: HistoryEmotion | null;
  consecutiveFrames: number;
  lastEmittedEmotion: HistoryEmotion | null;
}

export function createEmotionHistoryTracker(): EmotionHistoryTrackerState {
  return { candidate: null, consecutiveFrames: 0, lastEmittedEmotion: null };
}

const META: Record<HistoryEmotion, HistoryEmotionMeta> = {
  happy: {
    emotion: 'happy',
    label: 'Happy',
    icon: '😊',
    rowClass: 'border-l-4 border-l-success bg-success/10',
    labelClass: 'text-success',
  },
  sad: {
    emotion: 'sad',
    label: 'Sad',
    icon: '😢',
    rowClass: 'border-l-4 border-l-info bg-info/10',
    labelClass: 'text-info',
  },
  angry: {
    emotion: 'angry',
    label: 'Angry',
    icon: '😠',
    rowClass: 'border-l-4 border-l-destructive bg-destructive/10',
    labelClass: 'text-destructive',
  },
  frightened: {
    emotion: 'frightened',
    label: 'Frightened',
    icon: '😨',
    rowClass: 'border-l-4 border-l-warning bg-warning/10',
    labelClass: 'text-warning',
  },
  surprised: {
    emotion: 'surprised',
    label: 'Surprised',
    icon: '😲',
    rowClass: 'border-l-4 border-l-primary bg-primary/10',
    labelClass: 'text-primary',
  },
  neutral: {
    emotion: 'neutral',
    label: 'Neutral',
    icon: '😐',
    rowClass: 'border-l-4 border-l-muted-foreground bg-muted/40',
    labelClass: 'text-muted-foreground',
  },
  disgust: {
    emotion: 'disgust',
    label: 'Disgust',
    icon: '🤢',
    rowClass: 'border-l-4 border-l-accent bg-accent/10',
    labelClass: 'text-accent',
  },
};

/**
 * Convert face-api's seven expression classes into the history vocabulary.
 * Surprised/shock is intentionally distinct from Frightened and never becomes
 * distress evidence for the accepted-keyword validation rule.
 */
export function historyEmotionMeta(expression: string | null | undefined): HistoryEmotionMeta | null {
  const normalized = (expression ?? '').trim().toLowerCase();
  if (normalized === 'happy') return META.happy;
  if (normalized === 'sad' || normalized === 'sadness') return META.sad;
  if (normalized === 'angry' || normalized === 'anger') return META.angry;
  if (normalized === 'fearful' || normalized === 'fear' || normalized === 'frightened') return META.frightened;
  if (normalized === 'surprised' || normalized === 'surprise' || normalized === 'shock' || normalized === 'shocked') {
    return META.surprised;
  }
  if (normalized === 'neutral') return META.neutral;
  if (normalized === 'disgusted' || normalized === 'disgust') return META.disgust;
  return null;
}

/**
 * Record only a stable change in the dominant expression, not every analyzed
 * frame. Two consecutive confident frames confirm the label; it is emitted
 * once until another expression takes over or the face leaves the frame.
 */
export function observeEmotionHistory(
  previous: EmotionHistoryTrackerState,
  expression: string | null | undefined,
  confidence: number,
  hasFace: boolean,
): { state: EmotionHistoryTrackerState; event: HistoryEmotionMeta | null } {
  if (!hasFace) return { state: createEmotionHistoryTracker(), event: null };

  const emotion = historyEmotionMeta(expression);
  if (!emotion || !Number.isFinite(confidence) || confidence < HISTORY_EXPRESSION_MIN_CONFIDENCE) {
    return {
      state: { ...previous, candidate: null, consecutiveFrames: 0 },
      event: null,
    };
  }

  const consecutiveFrames = previous.candidate === emotion.emotion
    ? previous.consecutiveFrames + 1
    : 1;
  const shouldEmit = consecutiveFrames >= HISTORY_EXPRESSION_STABLE_FRAMES
    && previous.lastEmittedEmotion !== emotion.emotion;

  return {
    state: {
      candidate: emotion.emotion,
      consecutiveFrames,
      lastEmittedEmotion: shouldEmit ? emotion.emotion : previous.lastEmittedEmotion,
    },
    event: shouldEmit ? emotion : null,
  };
}
