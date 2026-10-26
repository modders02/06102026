export type HistoryEmotion = 'happy' | 'sad' | 'angry' | 'frightened' | 'surprised' | 'neutral' | 'disgust';

export interface HistoryEmotionMeta {
  emotion: HistoryEmotion;
  label: 'Happy' | 'Sad' | 'Angry' | 'Frightened' | 'Surprised' | 'Neutral' | 'Disgust';
  icon: string;
  rowClass: string;
  labelClass: string;
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
    icon: '😲',
    rowClass: 'border-l-4 border-l-warning bg-warning/10',
    labelClass: 'text-warning',
  },
  surprised: {
    emotion: 'surprised',
    label: 'Surprised',
    icon: '😮',
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
 * Show face-api's seven supported facial-expression classes distinctly.
 * In particular, a surprised face is not proof that someone is frightened.
 * This is history/display labeling only; emergency fusion is unchanged.
 */
export function historyEmotionMeta(expression: string | null | undefined): HistoryEmotionMeta | null {
  const normalized = (expression ?? '').trim().toLowerCase();
  if (normalized === 'happy') return META.happy;
  if (normalized === 'sad') return META.sad;
  if (normalized === 'angry' || normalized === 'anger') return META.angry;
  if (normalized === 'fearful' || normalized === 'fear' || normalized === 'frightened') return META.frightened;
  if (normalized === 'surprised' || normalized === 'surprise'
    || normalized === 'shock' || normalized === 'shocked') return META.surprised;
  if (normalized === 'neutral') return META.neutral;
  if (normalized === 'disgusted' || normalized === 'disgust') return META.disgust;
  return null;
}
