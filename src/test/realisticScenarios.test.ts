import { describe, expect, it } from 'vitest';
import { computeAttentionScore } from '@/lib/attentionFusion';
import { validateFusionCycle } from '@/lib/signalValidation';
import {
  fuseDistressSignals,
  makeDistressFaceSignal,
  makeDistressSpeechSignal,
} from '@/lib/multimodalDistress';
import {
  fuseFireWithSpeech,
  isImmediateFireSmoke,
  makeFireVisualSignal,
  makeFireSpeechSignal,
} from '@/lib/fireFusion';

describe('panelist realistic-condition scenario matrix', () => {
  it('low light does not discard usable audio/object evidence', () => {
    const validation = validateFusionCycle({
      visibility: 12,
      audioConnected: true,
      audioReady: true,
      objectScore: 60,
    });
    expect(validation.ready).toBe(true);
    expect(validation.flags).toContain('low-light');
    expect(computeAttentionScore(2, 70, 60)).toBeGreaterThan(15);
  });

  it('noisy or ambiguous speech cannot create distress without validated face evidence', () => {
    const speech = makeDistressSpeechSignal('help', 0.95, 1000);
    expect(speech).not.toBeNull();
    expect(fuseDistressSignals(null, speech)).toBeNull();
    expect(fuseDistressSignals(
      makeDistressFaceSignal('neutral', 0.99, 1000),
      speech,
    )).toBeNull();
  });

  it('validated Frightened + help still produces multimodal distress', () => {
    const face = makeDistressFaceSignal('surprised', 0.9, 1000);
    const speech = makeDistressSpeechSignal('help', 0.95, 2000);
    expect(fuseDistressSignals(face, speech)).not.toBeNull();
  });

  it('fire-colored visuals need corroboration when they are only candidates', () => {
    const candidate = makeFireVisualSignal(true, 0.4, 0.002, 0.03, 80, 1000);
    expect(isImmediateFireSmoke(candidate)).toBe(false);
    expect(fuseFireWithSpeech(candidate, null)).toBeNull();
    expect(fuseFireWithSpeech(candidate, makeFireSpeechSignal('fire', 0.95, 1500))).not.toBeNull();
  });

  it('visual fire + temporal smoke evidence remains valid without speech', () => {
    const candidate = makeFireVisualSignal(true, 0.5, 0.01, 0.25, 55, 1000, true, false);
    expect(isImmediateFireSmoke(candidate)).toBe(true);
  });
});
