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

  it('rejects weak or unrelated facial expressions', () => {
    expect(makeDistressFaceSignal('angry', DISTRESS_FACE_MIN_CONFIDENCE - 0.01, 1000)).toBeNull();
    expect(makeDistressFaceSignal('happy', 0.99, 1000)).toBeNull();
    expect(makeDistressFaceSignal('sad', 0.99, 1000)).toBeNull();
    expect(makeDistressFaceSignal('neutral', 0.99, 1000)).toBeNull();
    expect(makeDistressFaceSignal('disgusted', 0.99, 1000)).toBeNull();
  });

  it.each([
    ['help', 'help'],
    ['please help me', 'help'],
    ['emergency', 'emergency'],
    ['this is an emergency', 'emergency'],
  ] as const)('recognizes explicit English fusion speech %s', (transcript, keyword) => {
    expect(makeDistressSpeechSignal(transcript, 0.95, 2000)).toMatchObject({
      keyword,
      confidence: 0.95,
      at: 2000,
    });
  });

  it('does not treat unrelated safety speech as the fusion keyword', () => {
    expect(makeDistressSpeechSignal('call the police', 1, 2000)).toBeNull();
    expect(makeDistressSpeechSignal('fire in the kitchen', 1, 2000)).toBeNull();
    expect(makeDistressSpeechSignal('tulong', 1, 2000)).toBeNull();
  });

  it('recognizes scream audio separately from speech', () => {
    expect(makeDistressSoundSignal('scream', 0.9, 2500)).toEqual({
      keyword: 'scream',
      transcript: '',
      confidence: 0.9,
      at: 2500,
    });
    expect(makeDistressSoundSignal('screaming', 0.8, 2500)?.keyword).toBe('scream');
    expect(makeDistressSoundSignal('bang', 1, 2500)).toBeNull();
  });

  it.each([
    ['angry', 'Angry'],
    ['fearful', 'Frightened'],
    ['surprised', 'Frightened'],
  ] as const)('verifies screaming with %s', (expression, label) => {
    const face = makeDistressFaceSignal(expression, 0.92, 5000)!;
    const scream = makeDistressSoundSignal('scream', 0.95, 7000)!;
    const result = fuseDistressSignals(face, scream);
    expect(result?.face.label).toBe(label);
    expect(result?.confidence).toBe(0.92);
    expect(multimodalDistressLabel(result!)).toBe(`Verified distress: ${label} + screaming`);
  });

  it.each(['surprised', 'shock', 'shocked'] as const)(
    'verifies %s + help/emergency as Frightened distress',
    expression => {
      const face = makeDistressFaceSignal(expression, 0.93, 5000)!;
      const help = makeDistressSpeechSignal('help', 0.96, 6000)!;
      const emergency = makeDistressSpeechSignal('emergency', 0.95, 6000)!;
      expect(multimodalDistressLabel(fuseDistressSignals(face, help)!))
        .toBe('Verified distress: Frightened + "help"');
      expect(multimodalDistressLabel(fuseDistressSignals(face, emergency)!))
        .toBe('Verified distress: Frightened + "emergency"');
    },
  );

  it('verifies either ordering inside the ten-second same-camera window', () => {
    const face = makeDistressFaceSignal('fearful', 0.91, 10_000)!;
    const speechAfter = makeDistressSpeechSignal('help me', 0.96, 10_000 + MULTIMODAL_FUSION_WINDOW_MS)!;
    const speechBefore = makeDistressSpeechSignal('emergency', 0.88, 10_000 - MULTIMODAL_FUSION_WINDOW_MS)!;

    const after = fuseDistressSignals(face, speechAfter);
    const before = fuseDistressSignals(face, speechBefore);
    expect(after?.confidence).toBe(0.91);
    expect(before?.confidence).toBe(0.88);
    expect(multimodalDistressLabel(after!)).toBe('Verified distress: Frightened + "help"');
  });

  it('rejects signals outside the fusion window', () => {
    const face = makeDistressFaceSignal('angry', 0.9, 1000)!;
    const speech = makeDistressSpeechSignal('emergency', 0.95, 1000 + MULTIMODAL_FUSION_WINDOW_MS + 1)!;
    expect(fuseDistressSignals(face, speech)).toBeNull();
  });
});
