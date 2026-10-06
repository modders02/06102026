export type HistoryEmotion = 'happy' | 'sad' | 'shock';

export interface HistoryEmotionMeta {
  emotion: HistoryEmotion;
  label: 'Happy' | 'Sad' | 'Shock';
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
  shock: {
    emotion: 'shock',
    label: 'Shock',
    icon: '😲',
    rowClass: 'border-l-4 border-l-warning bg-warning/10',
    labelClass: 'text-warning',
  },
};

/**
 * face-api calls the shock-like base expression "surprised".
 * Keep the UI/research wording as "Shock" while accepting either form.
 */
export function historyEmotionMeta(expression: string | null | undefined): HistoryEmotionMeta | null {
  const normalized = (expression ?? '').trim().toLowerCase();
  if (normalized === 'happy') return META.happy;
  if (normalized === 'sad') return META.sad;
  if (normalized === 'surprised' || normalized === 'surprise' || normalized === 'shock' || normalized === 'shocked') {
    return META.shock;
  }
  return null;
}
