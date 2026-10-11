import { describe, expect, it } from 'vitest';
import { createFireState, detectFire } from '@/lib/fireDetection';
import type { DetectedObject } from '@/types/dashboard';

function nightFrame(
  width = 120,
  height = 80,
  hotspot: [number, number, number, number] | null = [48, 24, 24, 36],
  hotspotLevel = 225,
): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  const [hx, hy, hw, hh] = hotspot ?? [0, 0, 0, 0];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const hot = hotspot
        && x >= hx && x < hx + hw
        && y >= hy && y < hy + hh;

      // Infrared-style grayscale frame: the room is almost black and the fire
      // appears as a bright neutral hotspot rather than red/orange RGB.
      const value = hot ? hotspotLevel : 24;
      data[i] = value;
      data[i + 1] = value;
      data[i + 2] = value;
      data[i + 3] = 255;
    }
  }

  return { data, width, height } as ImageData;
}

const screen: DetectedObject = {
  label: 'tv',
  confidence: 0.96,
  bbox: [38, 14, 48, 56],
};

describe('night-vision fire detection', () => {
  it('detects a flickering bright fire hotspot in a dark infrared scene', () => {
    const state = createFireState();

    const first = detectFire(
      nightFrame(120, 80, [48, 24, 24, 36], 210),
      state,
    );
    expect(first.nightVisionMode).toBe(true);
    expect(first.fireDetected).toBe(false);
    expect(first.rejectedReason).toMatch(/night-vision hotspot/i);

    const second = detectFire(
      nightFrame(120, 80, [46, 22, 30, 40], 232),
      state,
    );
    expect(second.fireDetected).toBe(false);

    const third = detectFire(
      nightFrame(120, 80, [50, 20, 22, 44], 248),
      state,
    );

    expect(third.nightVisionMode).toBe(true);
    expect(third.firePixelRatio).toBeGreaterThan(0.003);
    expect(third.fireCandidate).toBe(true);
    expect(third.fireDetected).toBe(true);
    expect(third.detected).toBe(true);
    expect(third.confidence).toBeGreaterThan(0.3);
    expect(third.bbox).toBeDefined();
  });

  it('does not treat IR auto-exposure brightness fluctuation on a fixed hotspot as fire', () => {
    const state = createFireState();

    const levels = [205, 235, 215, 245, 225];
    let result = detectFire(
      nightFrame(120, 80, [48, 24, 24, 36], levels[0]),
      state,
    );
    for (const level of levels.slice(1)) {
      result = detectFire(
        nightFrame(120, 80, [48, 24, 24, 36], level),
        state,
      );
    }

    expect(result.nightVisionMode).toBe(true);
    expect(result.fireCandidate).toBe(false);
    expect(result.fireDetected).toBe(false);
    expect(result.detected).toBe(false);
  });

  it('does not call a static bright lamp in darkness a fire', () => {
    const state = createFireState();
    let result = detectFire(
      nightFrame(120, 80, [48, 24, 24, 36], 225),
      state,
    );

    for (let index = 0; index < 6; index++) {
      result = detectFire(
        nightFrame(120, 80, [48, 24, 24, 36], 225),
        state,
      );
    }

    expect(result.nightVisionMode).toBe(true);
    expect(result.fireCandidate).toBe(false);
    expect(result.fireDetected).toBe(false);
    expect(result.detected).toBe(false);
    expect(result.rejectedReason).toMatch(/night-vision hotspot|flicker/i);
  });

  it('does not detect fire when a dark frame has no bright hotspot', () => {
    const result = detectFire(nightFrame(120, 80, null), createFireState());

    expect(result.firePixelRatio).toBe(0);
    expect(result.fireCandidate).toBe(false);
    expect(result.fireDetected).toBe(false);
    expect(result.detected).toBe(false);
  });

  it('keeps display-screen suppression active in night vision', () => {
    const state = createFireState();

    detectFire(
      nightFrame(120, 80, [48, 24, 24, 36], 210),
      state,
      [screen],
    );
    const result = detectFire(
      nightFrame(120, 80, [46, 22, 30, 40], 238),
      state,
      [screen],
    );

    expect(result.nightVisionMode).toBe(true);
    expect(result.screenSuppressed).toBe(true);
    expect(result.fireCandidate).toBe(false);
    expect(result.fireDetected).toBe(false);
    expect(result.detected).toBe(false);
  });
});
