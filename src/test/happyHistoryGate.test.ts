import { describe, expect, it } from 'vitest';
import {
  advanceHappyHistory, freshHappyHistoryState,
  HAPPY_HISTORY_MIN_CONFIDENCE,
} from '@/lib/happyHistoryGate';

describe('History-only Happy expression transition gate', () => {
  const frame = (expression: string | null, probability: number, hasFace = true) => ({
    hasFace, expression, probability,
  });

  it('requires two consecutive confident Happy observations instead of saving every frame', () => {
    let state = freshHappyHistoryState();
    const first = advanceHappyHistory(state, frame('happy', 0.92));
    expect(first.emit).toBe(false);
    state = first.state;
    const second = advanceHappyHistory(state, frame('happy', 0.95));
    expect(second.emit).toBe(true);
    state = second.state;
    for (let i = 0; i < 30; i++) {
      const next = advanceHappyHistory(state, frame('happy', 0.99));
      expect(next.emit).toBe(false);
      state = next.state;
    }
  });

  it('never saves weak Happy estimates, Neutral, no-face, or missing values', () => {
    for (const observation of [
      frame('happy', HAPPY_HISTORY_MIN_CONFIDENCE - 0.01),
      frame('neutral', 0.99),
      frame('happy', 0.99, false),
      frame(null, 1),
      frame('happy', Number.NaN),
      frame('happy', 2),
    ]) {
      const result = advanceHappyHistory(freshHappyHistoryState(), observation);
      expect(result.state).toEqual(freshHappyHistoryState());
      expect(result.emit).toBe(false);
    }
  });

  it('resets a partial sequence on a missing/neutral frame and rearms on a new expression episode', () => {
    let state = freshHappyHistoryState();
    state = advanceHappyHistory(state, frame('happy', 0.92)).state;
    state = advanceHappyHistory(state, frame('neutral', 0.94)).state;
    expect(advanceHappyHistory(state, frame('happy', 0.92)).emit).toBe(false);

    state = advanceHappyHistory(state, frame('happy', 0.92)).state;
    const positive = advanceHappyHistory(state, frame('happy', 0.93));
    expect(positive.emit).toBe(true);
    const stillHappy = advanceHappyHistory(positive.state, frame('happy', 0.97));
    expect(stillHappy.emit).toBe(false);
    const reset = advanceHappyHistory(stillHappy.state, frame(null, 0, false));
    expect(reset.state).toEqual(freshHappyHistoryState());
    const newEpisode = advanceHappyHistory(
      advanceHappyHistory(reset.state, frame('happy', 0.90)).state,
      frame('happy', 0.93),
    );
    expect(newEpisode.emit).toBe(true);
  });

  it('accepts high-confidence Happy case-insensitively without implying true mood', () => {
    const result = advanceHappyHistory(
      advanceHappyHistory(freshHappyHistoryState(), frame(' Happy ', 0.8)).state,
      frame('HAPPY', 0.9),
    );
    expect(result.emit).toBe(true);
  });
});
