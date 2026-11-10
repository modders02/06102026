import { describe, expect, it } from 'vitest';
import {
  createEmotionHistoryTracker,
  historyEmotionMeta,
  observeEmotionHistory,
} from '@/lib/emotionEvents';

describe('facial-expression Event History labels', () => {
  it.each([
    ['happy', 'Happy'],
    ['sad', 'Sad'],
    ['angry', 'Angry'],
    ['fearful', 'Frightened'],
    ['neutral', 'Neutral'],
    ['disgusted', 'Disgust'],
    ['surprised', 'Surprised'],
    ['surprise', 'Surprised'],
    ['shock', 'Surprised'],
    ['shocked', 'Surprised'],
  ])('maps %s to the independent %s history category', (source, expected) => {
    expect(historyEmotionMeta(source)?.label).toBe(expected);
  });

  it('keeps surprise separate from frightened', () => {
    expect(historyEmotionMeta('surprised')?.emotion).toBe('surprised');
    expect(historyEmotionMeta('fearful')?.emotion).toBe('frightened');
  });
});

describe('stable expression transition recording', () => {
  it('records Happy after two confident frames and does not repeat it every frame', () => {
    let state = createEmotionHistoryTracker();
    const first = observeEmotionHistory(state, 'happy', 0.92, true);
    state = first.state;
    expect(first.event).toBeNull();

    const second = observeEmotionHistory(state, 'happy', 0.94, true);
    state = second.state;
    expect(second.event?.label).toBe('Happy');

    const third = observeEmotionHistory(state, 'happy', 0.96, true);
    state = third.state;
    expect(third.event).toBeNull();
  });

  it('records a new expression when the stable facial expression changes', () => {
    let state = createEmotionHistoryTracker();
    state = observeEmotionHistory(state, 'happy', 0.95, true).state;
    state = observeEmotionHistory(state, 'happy', 0.95, true).state;

    const firstSad = observeEmotionHistory(state, 'sad', 0.88, true);
    state = firstSad.state;
    expect(firstSad.event).toBeNull();

    const secondSad = observeEmotionHistory(state, 'sad', 0.90, true);
    state = secondSad.state;
    expect(secondSad.event?.label).toBe('Sad');
  });

  it('does not record weak guesses and resets the expression session when the face leaves', () => {
    let state = createEmotionHistoryTracker();
    const weak = observeEmotionHistory(state, 'happy', 0.40, true);
    state = weak.state;
    expect(weak.event).toBeNull();

    const noFace = observeEmotionHistory(state, null, 0, false);
    state = noFace.state;
    expect(state.lastEmittedEmotion).toBeNull();

    const first = observeEmotionHistory(state, 'happy', 0.92, true);
    const second = observeEmotionHistory(first.state, 'happy', 0.92, true);
    expect(second.event?.label).toBe('Happy');
  });
});
