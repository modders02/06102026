import { describe, expect, it } from 'vitest';
import { createFireState, detectFire } from '@/lib/fireDetection';

function smokeFrame(
  smokeShare: number,
  width = 120,
  height = 80,
): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  const smokeWidth = Math.round(width * smokeShare);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (x < smokeWidth) {
        // Neutral gray haze: low saturation, mid luminance.
        data[i] = 145;
        data[i + 1] = 145;
        data[i + 2] = 145;
      } else {
        // Saturated blue room content provides a clear baseline that is not
        // classified as smoke.
        data[i] = 30;
        data[i + 1] = 80;
        data[i + 2] = 175;
      }
      data[i + 3] = 255;
    }
  }

  return { data, width, height } as ImageData;
}

describe('standalone smoke detection', () => {
  it('confirms sustained rising smoke only after visibility also degrades', () => {
    const state = createFireState();
    const shares = [0.02, 0.08, 0.18, 0.35, 0.60, 0.88];

    let result = detectFire(smokeFrame(shares[0]), state);
    for (const share of shares.slice(1)) {
      result = detectFire(smokeFrame(share), state);
    }

    expect(result.fireDetected).toBe(false);
    expect(result.smokeRatio).toBeGreaterThanOrEqual(0.18);
    expect(result.visibility).toBeLessThanOrEqual(45);
    expect(result.smokeCorroborated).toBe(true);
    expect(result.lowVisibilityCorroborated).toBe(true);
    expect(result.smokeEmergency).toBe(true);
    expect(result.detected).toBe(true);
  });

  it('does not confirm a static gray scene as smoke', () => {
    const state = createFireState();
    let result = detectFire(smokeFrame(0.9), state);

    for (let index = 0; index < 8; index++) {
      result = detectFire(smokeFrame(0.9), state);
    }

    expect(result.smokeRatio).toBeGreaterThanOrEqual(0.18);
    expect(result.smokeCorroborated).toBe(false);
    expect(result.lowVisibilityCorroborated).toBe(false);
    expect(result.smokeEmergency).toBe(false);
  });

  it('does not confirm smoke from one noisy gray frame', () => {
    const result = detectFire(smokeFrame(0.95), createFireState());

    expect(result.smokeEmergency).toBe(false);
    expect(result.fireDetected).toBe(false);
  });
});
