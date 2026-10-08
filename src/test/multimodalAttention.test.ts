import { describe, expect, it } from 'vitest';
import { ATTENTION_WEIGHTS, computeMultimodalAttention, computeObjectImportance } from '@/lib/multimodalAttention';

describe('multimodal attention', () => {
  it('uses the thesis 0.4/0.3/0.3 weights', () => {
    expect(ATTENTION_WEIGHTS).toEqual({ visual: 0.4, audio: 0.3, object: 0.3   it('accumulates safety-weighted priority object confidence', () => {
    const score = computeObjectImportance([
      { label: 'person', confidence: 0.8, bbox: [0, 0, 10, 10] },
      { label: 'knife', confidence: 0.7, bbox: [10, 10, 5, 5] },
      { label: 'book', confidence: 0.9, bbox: [20, 20, 5, 5] },
    ], ['person', 'knife']);
    expect(score).toBe(100);
  });
});
    expect(computeMultimodalAttention({ visual: 100, audio: 0, object: 0 })).toBe(40);
    expect(computeMultimodalAttention({ visual: 0, audio: 100, object: 0 })).toBe(30);
    expect(computeMultimodalAttention({ visual: 0, audio: 0, object: 100 })).toBe(30);
  });

  it('clamps invalid/out-of-range component scores', () => {
    expect(computeMultimodalAttention({ visual: 200, audio: -10, object: Number.NaN })).toBe(40);
  });
});
