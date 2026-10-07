import { describe, expect, it } from 'vitest';
import { createFireState, detectFire } from '@/lib/fireDetection';
import type { DetectedObject } from '@/types/dashboard';

function roomWithOrangeShirt(width = 200, height = 120) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const shirt = x >= 75 && x < 125 && y >= 65 && y < 115;
      if (shirt) {
        data[i] = 245;
        data[i + 1] = 145;
        data[i + 2] = 35;
      } else {
        // Neutral gray indoor background: this intentionally resembles the
        // screenshot that previously produced a 50%+ false "smoke" ratio.
        data[i] = 115;
        data[i + 1] = 115;
        data[i + 2] = 115;
      }
      data[i + 3] = 255;
    }
  }
  return { data, width, height } as ImageData;
}

const person: DetectedObject = {
  label: 'person',
  confidence: 0.84,
  bbox: [45, 10, 115, 110],
};

describe('fire false-positive filtering on people', () => {
  it('suppresses an orange shirt inside a detected person', () => {
    const state = createFireState();
    const result = detectFire(roomWithOrangeShirt(), state, [person]);

    expect(result.smokeRatio).toBeGreaterThan(0.5);
    expect(result.firePixelRatio).toBeGreaterThan(0);
    expect(result.fireCandidate).toBe(false);
    expect(result.fireDetected).toBe(false);
    expect(result.detected).toBe(false);
    expect(result.smokeCorroborated).toBe(false);
    expect(result.lowVisibilityCorroborated).toBe(false);
    expect(result.rejectedReason).toMatch(/person\/clothing/);
  });

  it('does not treat a static gray room as temporal smoke evidence', () => {
    const state = createFireState();
    let result = detectFire(roomWithOrangeShirt(), state, []);

    for (let i = 0; i < 7; i++) {
      result = detectFire(roomWithOrangeShirt(), state, []);
    }

    expect(result.smokeRatio).toBeGreaterThan(0.5);
    expect(result.smokeCorroborated).toBe(false);
    expect(result.lowVisibilityCorroborated).toBe(false);
  });
});
