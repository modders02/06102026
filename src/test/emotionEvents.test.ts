import { describe, expect, it } from 'vitest';
import { historyEmotionMeta } from '@/lib/emotionEvents';
import { makeDistressFaceSignal } from '@/lib/multimodalDistress';

describe('emotion display mapping', () => {
  it.each(['surprised', 'surprise', 'shock', 'shocked'] as const)(
    'shows %s as Surprised rather than Frightened',
    expression => {
      expect(historyEmotionMeta(expression)).toMatchObject({
        emotion: 'surprised',
        label: 'Surprised',
      });
      expect(makeDistressFaceSignal(expression, 0.99)).toBeNull();
    },
  );

  it.each(['fearful', 'fear', 'frightened'] as const)(
    'reserves %s for frightened facial evidence',
    expression => {
      expect(historyEmotionMeta(expression)).toMatchObject({
        emotion: 'frightened',
        label: 'Frightened',
      });
      expect(makeDistressFaceSignal(expression, 0.90)).toMatchObject({
        label: 'Frightened',
        confidence: 0.90,
      });
    },
  );

  it('preserves angry validation and keeps informational classes unchanged', () => {
    expect(makeDistressFaceSignal('angry', 0.90)?.label).toBe('Angry');
    expect(historyEmotionMeta('anger')?.label).toBe('Angry');
    expect(historyEmotionMeta('sad')?.label).toBe('Sad');
    expect(historyEmotionMeta('happy')?.label).toBe('Happy');
    expect(historyEmotionMeta('neutral')?.label).toBe('Neutral');
    expect(historyEmotionMeta('disgusted')?.label).toBe('Disgust');
  });
});
