import { describe, expect, it } from 'vitest';
import {
  DISTRESS_FACE_MIN_CONFIDENCE,
  MULTIMODAL_FUSION_WINDOW_MS,
  fuseDistressSignals,
  makeDistressFaceSignal,
  makeDistressSpeechSignal,
  multimodalDistressLabel,
} from '@/lib/multimodalDistress';

describe('multimodal distress fusion', () => {
  it.each([
    ['angry', 'Angry'],
    ['fearful', 'Frightened'],
    ['frightened', 'Frightened'],
  ] as const)('accepts a reliable %s face', (expression, label) => {
    expect(makeDistressFaceSignal(expression, 0.9, 1000)).toEqual({
      label,
      confidence: 0.9,
      at: 1000,
    });
  });

  it('rejects weak or unrelated facial expressions', () => {
    expect(makeDistressFaceSignal('angry', DISTRESS_FACE_MIN_CONFIDENCE - 0.01, 1000)).toBeNull();
    expect(makeDistressFaceSignal('happy', 0.99, 1000)).toBeNull();
    expect(makeDistressFaceSignal('sad', 0.99, 1000)).toBeNull();
  });

  it.each([
    ['help', 'help'],
    ['please help me', 'help'],
    ['tulong', 'tulong'],
    ['tulong po', 'tulong'],
  ] as const)('recognizes explicit fusion speech %s', (transcript, keyword) => {
    expect(makeDistressSpeechSignal(transcript, 0.95, 2000)).toMatchObject({
      keyword,
      confidence: 0.95,
      at: 2000,
    });
  });

  it('does not treat unrelated safety speech as the fusion keyword', () => {
    expect(makeDistressSpeechSignal('call the police', 1, 2000)).toBeNull();
    expect(makeDistressSpeechSignal('fire in the kitchen', 1, 2000)).toBeNull();
  });

  it('verifies either ordering inside the ten-second same-camera window', () => {
    const face = makeDistressFaceSignal('fearful', 0.91, 10_000)!;
    const speechAfter = makeDistressSpeechSignal('help me', 0.96, 10_000 + MULTIMODAL_FUSION_WINDOW_MS)!;
    const speechBefore = makeDistressSpeechSignal('tulong', 0.88, 10_000 - MULTIMODAL_FUSION_WINDOW_MS)!;

    const after = fuseDistressSignals(face, speechAfter);
    const before = fuseDistressSignals(face, speechBefore);
    expect(after?.confidence).toBe(0.91);
    expect(before?.confidence).toBe(0.88);
    expect(multimodalDistressLabel(after!)).toBe('Verified distress: Frightened + "help"');
  });

  it('rejects signals outside the fusion window', () => {
    const face = makeDistressFaceSignal('angry', 0.9, 1000)!;
    const speech = makeDistressSpeechSignal('tulong', 0.95, 1000 + MULTIMODAL_FUSION_WINDOW_MS + 1)!;
    expect(fuseDistressSignals(face, speech)).toBeNull();
  });
});
