import { describe, expect, it } from 'vitest';
import {
  DISTRESS_FACE_MIN_CONFIDENCE,
  MULTIMODAL_FUSION_WINDOW_MS,
  fuseDistressSignals,
  makeDistressFaceSignal,
  makeDistressSoundSignal,
  makeDistressSpeechSignal,
  multimodalDistressLabel,
} from '@/lib/multimodalDistress';

describe('multimodal distress fusion', () => {
  it.each([
    ['angry', 'Angry'],
    ['fearful', 'Frightened'],
    ['frightened', 'Frightened'],
    ['surprised', 'Frightened'],
    ['shock', 'Frightened'],
  ] as const)('accepts a reliable %s face', (expression, label) => {
    expect(makeDistressFaceSignal(expression, 0.9, 1000)).toEqual({
      label,
      confidence: 0.9,
      at: 1000,
    });
  });

  it('rejects weak or non-target facial expressions', () => {
    expect(makeDistressFaceSignal('angry', DISTRESS_FACE_MIN_CONFIDENCE - 0.01, 1000)).toBeNull();
    expect(makeDistressFaceSignal('happy', 0.99, 1000)).toBeNull();
    expect(makeDistressFaceSignal('sad', 0.99, 1000)).toBeNull();
    expect(makeDistressFaceSignal('neutral', 0.99, 1000)).toBeNull();
    expect(makeDistressFaceSignal('disgusted', 0.99, 1000)).toBeNull();
  });

  it.each([
    ['help', 'help'],
    ['please help me', 'help'],
  ] as const)('recognizes explicit help speech %s', (transcript, keyword) => {
    expect(makeDistressSpeechSignal(transcript, 0.95, 2000)).toMatchObject({
      keyword,
      confidence: 0.95,
      at: 2000,
    });
  });

  it('rejects every non-help distress phrase for fusion', () => {
    expect(makeDistressSpeechSignal('emergency', 1, 2000)).toBeNull();
    expect(makeDistressSpeechSignal('call the police', 1, 2000)).toBeNull();
    expect(makeDistressSpeechSignal('fire in the kitchen', 1, 2000)).toBeNull();
    expect(makeDistressSpeechSignal('tulong', 1, 2000)).toBeNull();
  });

  it('does not use scream audio as distress fusion evidence', () => {
    expect(makeDistressSoundSignal('scream', 0.9, 2500)).toBeNull();
    expect(makeDistressSoundSignal('screaming', 0.8, 2500)).toBeNull();
    expect(makeDistressSoundSignal('bang', 1, 2500)).toBeNull();
  });

  it.each([
    ['angry', 'Angry'],
    ['fearful', 'Frightened'],
    ['frightened', 'Frightened'],
    ['surprised', 'Frightened'],
    ['shock', 'Frightened'],
  ] as const)('verifies accepted help with %s', (expression, label) => {
    const face = makeDistressFaceSignal(expression, 0.92, 5000)!;
    const help = makeDistressSpeechSignal('help', 0.95, 7000)!;
    const result = fuseDistressSignals(face, help);
    expect(result?.face.label).toBe(label);
    expect(result?.confidence).toBe(0.92);
    expect(multimodalDistressLabel(result!)).toBe(`Verified distress: ${label} + "help"`);
  });

  it('verifies either ordering inside the ten-second same-camera window', () => {
    const face = makeDistressFaceSignal('fearful', 0.91, 10_000)!;
    const speechAfter = makeDistressSpeechSignal('help me', 0.96, 10_000 + MULTIMODAL_FUSION_WINDOW_MS)!;
    const speechBefore = makeDistressSpeechSignal('help', 0.88, 10_000 - MULTIMODAL_FUSION_WINDOW_MS)!;

    const after = fuseDistressSignals(face, speechAfter);
    const before = fuseDistressSignals(face, speechBefore);
    expect(after?.confidence).toBe(0.91);
    expect(before?.confidence).toBe(0.88);
    expect(multimodalDistressLabel(after!)).toBe('Verified distress: Frightened + "help"');
  });

  it('rejects help outside the fusion window', () => {
    const face = makeDistressFaceSignal('angry', 0.9, 1000)!;
    const speech = makeDistressSpeechSignal('help', 0.95, 1000 + MULTIMODAL_FUSION_WINDOW_MS + 1)!;
    expect(fuseDistressSignals(face, speech)).toBeNull();
  });
});
