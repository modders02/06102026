import { describe, expect, it } from 'vitest';
import {
  DISTRESS_FACE_MIN_CONFIDENCE,
  MULTIMODAL_FUSION_WINDOW_MS,
  fuseDistressSignals,
  makeDistressFaceSignal,
  makeDistressSoundSignal,
  makeDistressSpeechSignal,
  multimodalDistressLabel,
  KEYWORD_FACE_PAIRINGS,
  isKeywordFaceCompatible,
  acceptedDistressReceiptTime,
  MAX_ACCEPTED_KWS_DELIVERY_LAG_MS,
} from '@/lib/multimodalDistress';

describe('multimodal distress fusion', () => {
  it('allows facial confirmation throughout the five-second validation window', () => {
    expect(MULTIMODAL_FUSION_WINDOW_MS).toBe(5_000);
    const speech = makeDistressSpeechSignal('help', 0.97, 10_000);
    const inside = makeDistressFaceSignal('fearful', 0.92, 14_999);
    const outside = makeDistressFaceSignal('fearful', 0.92, 15_001);
    expect(fuseDistressSignals(inside, speech)).not.toBeNull();
    expect(fuseDistressSignals(outside, speech)).toBeNull();
  });

  it('uses accepted keyword receipt for the live countdown after bounded ASR processing latency', () => {
    const receivedAt = Date.parse('2026-10-27T02:14:02Z');
    expect(acceptedDistressReceiptTime('2026-10-27T02:13:58Z', receivedAt)).toBe(receivedAt);
    const face = makeDistressFaceSignal('fearful', 0.85, receivedAt + 1800);
    const speech = makeDistressSpeechSignal('help', 0.94,
      acceptedDistressReceiptTime('2026-10-27T02:13:58Z', receivedAt)!);
    expect(fuseDistressSignals(face, speech)).toMatchObject({ confidence: 0.85 });
  });

  it('rejects stale/replayed, far-future, and invalid KWS timestamps', () => {
    const receivedAt = Date.parse('2026-10-27T02:14:02Z');
    expect(acceptedDistressReceiptTime(
      new Date(receivedAt - MAX_ACCEPTED_KWS_DELIVERY_LAG_MS - 1).toISOString(),
      receivedAt,
    )).toBeNull();
    expect(acceptedDistressReceiptTime(new Date(receivedAt + 5000).toISOString(), receivedAt)).toBeNull();
    expect(acceptedDistressReceiptTime('garbled', receivedAt)).toBeNull();
  });

  it.each([
    ['angry', 'Angry'],
    ['anger', 'Angry'],
    ['fearful', 'Frightened'],
    ['fear', 'Frightened'],
    ['frightened', 'Frightened'],
    ['surprised', 'Frightened'],
    ['surprise', 'Frightened'],
    ['shock', 'Frightened'],
    ['shocked', 'Frightened'],
    ['sad', 'Sad'],
    ['sadness', 'Sad'],
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
    expect(makeDistressFaceSignal('neutral', 0.99, 1000)).toBeNull();
    expect(makeDistressFaceSignal('disgusted', 0.99, 1000)).toBeNull();
  });

  it.each([
    ['help', 'help'],
    ['please help me', 'help'],
    ['EMERGENCY!', 'emergency'],
    ['danger', 'danger'],
    ['intruder', 'intruder'],
    ['call the police', 'police'],
    ['call an ambulance', 'ambulance'],
  ] as const)('recognizes explicit help speech %s', (transcript, keyword) => {
    expect(makeDistressSpeechSignal(transcript, 0.95, 2000)).toMatchObject({
      keyword,
      confidence: 0.95,
      at: 2000,
    });
  });

  it('reserves fire for visual verification and rejects unconfigured or partial words', () => {
    for (const phrase of ['fire', 'stop', 'helpful', 'dangerous', 'policeman', 'ambulances']) {
      expect(makeDistressSpeechSignal(phrase, 1, 2000)).toBeNull();
    }
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

  it('verifies either ordering inside the configured same-camera window', () => {
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

  it.each(Object.entries(KEYWORD_FACE_PAIRINGS).flatMap(([keyword, expressions]) =>
    expressions.map(expression => [keyword, expression] as const),
  ))('verifies configured %s + %s with the actual word in its evidence', (keyword, expression) => {
    const face = makeDistressFaceSignal(expression, 0.94, 1000);
    const speech = makeDistressSpeechSignal(keyword, 0.96, 1200);
    const result = fuseDistressSignals(face, speech);
    expect(result?.speech.keyword).toBe(keyword);
    expect(result?.confidence).toBe(0.94);
    expect(multimodalDistressLabel(result!)).toBe(`Verified distress: ${expression} + "${keyword}"`);
  });

  it.each(Object.keys(KEYWORD_FACE_PAIRINGS))('rejects incompatible and missing facial evidence for %s', keyword => {
    const speech = makeDistressSpeechSignal(keyword, 0.96, 1200);
    for (const expression of ['Angry', 'Frightened', 'Sad', 'Happy', 'Neutral', 'Disgust']) {
      if (!isKeywordFaceCompatible(keyword, expression)) {
        expect(fuseDistressSignals(makeDistressFaceSignal(expression, 0.94, 1000), speech)).toBeNull();
      }
    }
    expect(fuseDistressSignals(null, speech)).toBeNull();
    expect(fuseDistressSignals(makeDistressFaceSignal('fearful', 0.94, 1000),
      makeDistressSpeechSignal(keyword, 0.96, 1000 + MULTIMODAL_FUSION_WINDOW_MS + 1))).toBeNull();
  });
});
