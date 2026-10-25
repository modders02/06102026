import { describe, expect, it } from 'vitest';
import {
  classifyFacialMovement, stableFacialMovement,
  type FacialBlendshapeCategory, type FacialMovementObservation,
} from '@/lib/facialMovementCues';

const BASE = {
  jawOpen: 0.05,
  mouthSmileLeft: 0.05, mouthSmileRight: 0.05,
  eyeWideLeft: 0.05, eyeWideRight: 0.05,
  browDownLeft: 0.05, browDownRight: 0.05,
  mouthFrownLeft: 0.05, mouthFrownRight: 0.05, browInnerUp: 0.05,
};

function categories(features: Partial<typeof BASE> = {}): FacialBlendshapeCategory[] {
  return Object.entries({ ...BASE, ...features }).map(([categoryName, score]) => ({ categoryName, score }));
}

describe('MediaPipe 52-blendshape facial movement cue classifier', () => {
  it('detects a clear bilateral smile without calling it actual happiness', () => {
    const result = classifyFacialMovement(categories({ mouthSmileLeft: 0.78, mouthSmileRight: 0.72 }));
    expect(result).toMatchObject({
      kind: 'smile', label: 'Smiling', activation: 0.75,
      source: 'mediapipe-blendshapes',
    });
    expect(JSON.stringify(result)).not.toMatch(/happy|distress|emergency/i);
  });
  it('recognizes an open mouth, wide eyes and furrowed eyebrows as movements only', () => {
    expect(classifyFacialMovement(categories({ jawOpen: 0.88 }))?.kind).toBe('mouth-open');
    expect(classifyFacialMovement(categories({ eyeWideLeft: 0.73, eyeWideRight: 0.69 }))?.kind).toBe('eyes-wide');
    expect(classifyFacialMovement(categories({ browDownLeft: 0.81, browDownRight: 0.74 }))?.kind).toBe('brow-furrowed');
    expect(classifyFacialMovement(categories({ mouthFrownLeft: 0.75, mouthFrownRight: 0.76 }))?.kind)
      .toBe('lip-corners-down');
  });
  it('reports no dominant movement on complete neutral coefficients', () => {
    expect(classifyFacialMovement(categories())?.kind).toBe('neutral');
  });
  it('requires a complete minimum set instead of inventing neutral from missing data', () => {
    expect(classifyFacialMovement(null)).toBeNull();
    expect(classifyFacialMovement([])).toBeNull();
    expect(classifyFacialMovement([{ categoryName: 'jawOpen', score: 0.9 }])).toBeNull();
    expect(classifyFacialMovement(categories().filter(x => x.categoryName !== 'eyeWideLeft'))).toBeNull();
  });
  it('ignores malformed or impossible values rather than inflating expression scores', () => {
    expect(classifyFacialMovement(categories({ jawOpen: Number.NaN }))?.kind).toBe('neutral');
    expect(classifyFacialMovement(categories({ jawOpen: 5 }))?.kind).toBe('neutral');
    expect(classifyFacialMovement(categories({ jawOpen: -3 }))?.kind).toBe('neutral');
  });
  it('does not persist a facial expression after the face vanishes', () => {
    const smiling = classifyFacialMovement(categories({ mouthSmileLeft: 0.70, mouthSmileRight: 0.66 }))!;
    let tracked = stableFacialMovement([], smiling);
    expect(tracked.displayed).toBeNull();
    tracked = stableFacialMovement(tracked.history, smiling);
    expect(tracked.displayed?.kind).toBe('smile');
    const gone = stableFacialMovement(tracked.history, null);
    expect(gone.history).toEqual([]);
    expect(gone.displayed).toBeNull();
  });
  it('does not flicker on one anomalous frame', () => {
    const smiling = classifyFacialMovement(categories({ mouthSmileLeft: 0.70, mouthSmileRight: 0.66 }))!;
    const neutral = classifyFacialMovement(categories())!;
    const first = stableFacialMovement([smiling, smiling], neutral);
    expect(first.displayed?.kind).toBe('smile');
    const second = stableFacialMovement(first.history, neutral);
    expect(second.displayed?.kind).toBe('neutral');
  });
});
