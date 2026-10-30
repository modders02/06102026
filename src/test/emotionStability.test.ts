import { describe, expect, it } from 'vitest';
import {
  advanceDistressConfirmation, advanceEmotionStability,
  emptyDistressConfirmation, emptyEmotionStability,
} from '@/lib/emotionStability';

const frame = (label: string, at: number, source = 'fer') => ({
  label, confidence: 0.85, runnerUp: 0.10, source, at,
});

describe('facial expression temporal stability', () => {
  it('does not publish rapidly alternating expressions', () => {
    let s = emptyEmotionStability();
    for (const [index, label] of ['sad', 'happy', 'surprised', 'fearful', 'angry'].entries()) {
      s = advanceEmotionStability(s, frame(label, 1000 + index * 300));
      expect(s.accepted).toBeNull();
    }
  });

  it('publishes an emotion only after three consecutive strong samples', () => {
    let s = emptyEmotionStability();
    s = advanceEmotionStability(s, frame('happy', 1000));
    expect(s.accepted).toBeNull();
    s = advanceEmotionStability(s, frame('happy', 2000));
    expect(s.accepted).toBeNull();
    s = advanceEmotionStability(s, frame('happy', 3000));
    expect(s.accepted).toBe('happy');
    s = advanceEmotionStability(s, frame('sad', 4000));
    expect(s.accepted).toBe('happy');
    s = advanceEmotionStability(s, frame('sad', 5000));
    s = advanceEmotionStability(s, frame('sad', 6000));
    expect(s.accepted).toBe('sad');
  });

  it('rejects low-confidence and ambiguous near-tie labels', () => {
    let s = emptyEmotionStability();
    s = advanceEmotionStability(s, { ...frame('angry', 1000), confidence: 0.60 });
    expect(s.candidate).toBeNull();
    s = advanceEmotionStability(s, { ...frame('angry', 2000), runnerUp: 0.80 });
    expect(s.candidate).toBeNull();
  });

  it('requires fresh observations from the same classifier', () => {
    let s = emptyEmotionStability();
    s = advanceEmotionStability(s, frame('happy', 1000, 'faceapi'));
    s = advanceEmotionStability(s, frame('happy', 2000, 'faceapi'));
    s = advanceEmotionStability(s, frame('happy', 3000, 'fer'));
    expect(s.count).toBe(1);
    expect(s.accepted).toBeNull();
    s = advanceEmotionStability(s, frame('happy', 7000, 'fer'));
    expect(s.count).toBe(1);
    expect(advanceEmotionStability(s, null)).toEqual(emptyEmotionStability());
  });

  it('requires two distinct raw Face-api frames before safety evidence', () => {
    let s = emptyDistressConfirmation();
    s = advanceDistressConfirmation(s, 'angry', 0.9, 1000);
    expect(s.count).toBe(1);
    s = advanceDistressConfirmation(s, 'angry', 0.9, 1300);
    expect(s.count).toBe(2);
    s = advanceDistressConfirmation(s, 'fearful', 0.8, 1600);
    expect(s.count).toBe(1);
    s = advanceDistressConfirmation(s, null, 0.9, 1900);
    expect(s.count).toBe(0);
    s = advanceDistressConfirmation(s, 'angry', 0.9, 5000);
    expect(s.count).toBe(1);
  });
});
