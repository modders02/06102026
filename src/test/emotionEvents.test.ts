import { describe, expect, it } from 'vitest';
import { historyEmotionMeta } from '@/lib/emotionEvents';

describe('emotion display mapping', () => {
  it.each(['surprised', 'surprise', 'shock', 'shocked', 'fearful', 'fear', 'frightened'] as const)(
    'shows %s as Frightened',
    expression => {
      expect(historyEmotionMeta(expression)).toMatchObject({
        emotion: 'frightened',
        label: 'Frightened',
      });
    },
  );

  it('keeps unrelated informational emotions unchanged', () => {
    expect(historyEmotionMeta('sad')?.label).toBe('Sad');
    expect(historyEmotionMeta('happy')?.label).toBe('Happy');
    expect(historyEmotionMeta('neutral')?.label).toBe('Neutral');
    expect(historyEmotionMeta('disgusted')?.label).toBe('Disgust');
  });
});
