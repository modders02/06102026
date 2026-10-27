import { describe, expect, it } from 'vitest';
import { corroborateGeometryFear, emptyGeometryEvidenceState } from '@/lib/corroboratedFaceEvidence';

const geometryFear = {
  hasFace: true, expression: 'sad', probability: 0.99,
  historyExpression: 'fearful', historyConfidence: 0.64,
  historyGeometryCorrected: true,
};

describe('fresh corroborated facial evidence', () => {
  it('requires two different frames before yielding a frightened signal', () => {
    const first = corroborateGeometryFear(geometryFear, emptyGeometryEvidenceState(), 1000);
    expect(first.signal).toBeNull();
    const second = corroborateGeometryFear(geometryFear, first.state, 2000);
    expect(second.signal).toEqual({ label: 'Frightened', confidence: 0.64, at: 2000 });
  });

  it('rejects display-only history labels without an actual geometry correction', () => {
    const input = { ...geometryFear, historyGeometryCorrected: false };
    const first = corroborateGeometryFear(input, emptyGeometryEvidenceState(), 1000);
    expect(corroborateGeometryFear(input, first.state, 2000).signal).toBeNull();
  });

  it('does not validate one frame, old frames, or a changed expression', () => {
    const first = corroborateGeometryFear(geometryFear, emptyGeometryEvidenceState(), 1000);
    expect(corroborateGeometryFear(geometryFear, first.state, 5000).signal).toBeNull();
    const neutral = corroborateGeometryFear({ ...geometryFear, expression: 'neutral' }, first.state, 2000);
    expect(neutral.state.count).toBe(0);
    expect(corroborateGeometryFear(geometryFear, neutral.state, 2300).signal).toBeNull();
  });

  it('rejects low geometry score, low raw confidence, and invalid readings', () => {
    for (const variant of [
      { historyConfidence: 0.54 }, { probability: 0.40 },
      { historyExpression: 'happy' }, { probability: Number.NaN },
      { hasFace: false },
    ]) {
      const face = { ...geometryFear, ...variant };
      const first = corroborateGeometryFear(face, emptyGeometryEvidenceState(), 1000);
      expect(corroborateGeometryFear(face, first.state, 2000).signal).toBeNull();
    }
  });
});
