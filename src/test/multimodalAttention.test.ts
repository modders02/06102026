import { describe, expect, it } from 'vitest';
import { ATTENTION_WEIGHTS, computeMultimodalAttention } from '@/lib/multimodalAttention';

describe('multimodal attention', () => {
  it('uses the thesis 0.4/0.3/0.3 weights', () => {
    expect(ATTENTION_WEIGHTS).toEqual({ visual: 0.4, audio: 0.3, object: 0.3 });
    expect(computeMultimodalAttention({ visual: 100, audio: 0, object: 0 })).toBe(40);
    expect(computeMultimodalAttention({ visual: 0, audio: 100, object: 0 })).toBe(30);
    expect(computeMultimodalAttention({ visual: 0, audio: 0, object: 100 })).toBe(30);
  });

  it('clamps invalid/out-of-range component scores', () => {
    expect(computeMultimodalAttention({ visual: 200, audio: -10, object: Number.NaN })).toBe(40);
  });
});
