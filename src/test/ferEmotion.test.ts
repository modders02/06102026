import { describe, expect, it } from 'vitest';
import { parseFerResponse } from '@/lib/ferEmotion';

const base = {
  ok: true, has_face: true, engine: 'fer',
  scores: {
    angry: 0.02, disgust: 0.01, fear: 0.05, happy: 0.06,
    sad: 0.10, surprise: 0.72, neutral: 0.04,
  },
};

describe('optional FER result normalization', () => {
  it('keeps surprise separate from fear and requires a valid result', () => {
    expect(parseFerResponse(base)).toEqual({
      label: 'surprised', confidence: 0.72, runnerUp: 0.10,
    });
    expect(parseFerResponse({ ...base, scores: { ...base.scores, fear: 0.88, surprise: 0.03 } }))
      .toMatchObject({ label: 'fearful', confidence: 0.88 });
  });
  it('fails closed on non-faces, malformed responses, and scores', () => {
    expect(parseFerResponse({ ...base, has_face: false })).toBeNull();
    expect(parseFerResponse({ ...base, engine: 'unknown' })).toBeNull();
    expect(parseFerResponse({ ...base, scores: { ...base.scores, happy: NaN } })).toBeNull();
    expect(parseFerResponse({ ...base, scores: { ...base.scores, angry: 1.1 } })).toBeNull();
    expect(parseFerResponse({ ...base, scores: { ...base.scores, fear: undefined } })).toBeNull();
    expect(parseFerResponse(null)).toBeNull();
  });
});
