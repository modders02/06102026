import { describe, expect, it } from 'vitest';
import { createFireState, detectFire } from '@/lib/fireDetection';
import type { DetectedObject } from '@/types/dashboard';

function makeFrame(
  width: number,
  height: number,
  fireRect: [number, number, number, number],
): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      // Saturated blue background avoids looking like smoke.
      data[i] = 35;
      data[i + 1] = 85;
      data[i + 2] = 165;
      data[i + 3] = 255;
    }
  }

  const [rx, ry, rw, rh] = fireRect;
  for (let y = ry; y < Math.min(height, ry + rh); y++) {
    for (let x = rx; x < Math.min(width, rx + rw); x++) {
      const i = (y * width + x) * 4;
      // Deliberately satisfies the detector's fire-color rule.
      data[i] = 235;
      data[i + 1] = 135;
      data[i + 2] = 45;
      data[i + 3] = 255;
    }
  }

  return { data, width, height } as ImageData;
}

const person = (bbox: [number, number, number, number]): DetectedObject => ({
  label: 'person',
  confidence: 0.95,
  bbox,
});

describe('fire person/clothing suppression', () => {
  it('suppresses a moving orange shirt even when motion creates apparent flicker', () => {
    const state = createFireState();
    const objects = [person([8, 8, 84, 84])];

    const sizes = [42, 58, 44, 62, 46, 60, 43, 61];
    let result = detectFire(makeFrame(100, 100, [22, 24, sizes[0], 48]), state, objects);
    for (const size of sizes.slice(1)) {
      result = detectFire(makeFrame(100, 100, [22, 24, size, 48]), state, objects);
    }

    expect(result.fireCandidate).toBe(false);
    expect(result.detected).toBe(false);
    expect(result.confidence).toBe(0);
    expect(result.personFirePixelShare).toBeGreaterThanOrEqual(0.7);
    expect(result.outsidePersonFirePixelRatio).toBeLessThan(0.004);
    expect(result.rejectedReason).toContain('person/clothing');
  });

  it('does not apply clothing suppression to an independent fire-colored region beside a person', () => {
    const state = createFireState();
    const objects = [person([0, 0, 42, 100])];

    const result = detectFire(
      makeFrame(100, 100, [58, 18, 34, 54]),
      state,
      objects,
    );

    expect(result.personFirePixelShare).toBe(0);
    expect(result.outsidePersonFirePixelRatio).toBeGreaterThan(0.004);
    expect(result.rejectedReason ?? '').not.toContain('person/clothing');
  });
});
