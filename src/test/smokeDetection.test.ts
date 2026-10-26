import { describe, expect, it } from 'vitest';
import { createFireState, detectFire } from '@/lib/fireDetection';
import type { DetectedObject } from '@/types/dashboard';

/** The camera sees real edges and texture BEFORE any haze develops. */
function scene(
  opacity: number,
  options: { grayWall?: boolean; exposure?: number; personShare?: number } = {},
  width = 240,
  height = 160,
): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const stripe = (Math.floor(x / 5) + Math.floor(y / 7)) % 2 === 0;
      const rgb = options.grayWall
        ? [145, 145, 145]
        : stripe ? [30, 80, 155] : [55, 137, 225];
      const personRegion = x < (options.personShare ?? 0) * width;
      const source = personRegion ? [148, 148, 148] : rgb;
      const a = personRegion ? 0 : opacity;
      for (let channel = 0; channel < 3; channel++) {
        data[i + channel] = Math.min(255, Math.max(0, Math.round(
          (source[channel] * (1 - a) + 174 * a) * (options.exposure ?? 1),
        )));
      }
      data[i + 3] = 255;
    }
  }
  return { data, width, height } as ImageData;
}

describe('smoke verifier using temporal loss of background texture', () => {
  it('confirms only sustained obscuring haze over a previously visible textured room', () => {
    const state = createFireState();
    let result = detectFire(scene(0), state);
    for (let i = 0; i < 4; i++) result = detectFire(scene(0), state);
    expect(result.smokeEmergency).toBe(false);
    expect(result.fireDetected).toBe(false);

    for (const opacity of [0.15, 0.35, 0.52, 0.62, 0.72, 0.82, 0.88, 0.88, 0.88, 0.88]) {
      result = detectFire(scene(opacity), state);
    }
    expect(result.fireDetected).toBe(false);
    expect(result.smokeRatio).toBeGreaterThan(0.18);
    expect(result.smokeEmergency).toBe(true);
    expect(result.detected).toBe(true);
    expect(result.confidence).toBeLessThanOrEqual(0.85);
    expect(result.confidence).toBeGreaterThanOrEqual(0.60);
  });

  it('never confirms a completely gray stationary wall even after many frames', () => {
    const state = createFireState();
    let result = detectFire(scene(0, { grayWall: true }), state);
    for (let i = 0; i < 35; i++) result = detectFire(scene(0, { grayWall: true }), state);
    expect(result.smokeRatio).toBeGreaterThan(0.8);
    expect(result.smokeEmergency).toBe(false);
    expect(result.confidence).toBe(0);
    expect(result.fireDetected).toBe(false);
  });

  it('does not treat global camera exposure or brightness compensation as smoke', () => {
    const state = createFireState();
    for (let i = 0; i < 5; i++) detectFire(scene(0), state);
    for (const exposure of [1.25, 1.4, 1.2, 1.5, 1.15, 1.45, 1.25, 1.1]) {
      const result = detectFire(scene(0, { exposure }), state);
      expect(result.smokeEmergency).toBe(false);
    }
  });

  it('cannot promote a moving gray person to smoke despite gray pixel coverage', () => {
    const state = createFireState();
    for (let i = 0; i < 5; i++) detectFire(scene(0), state);
    for (const share of [0.08, 0.2, 0.35, 0.47, 0.55, 0.6, 0.3, 0.45]) {
      const objects: DetectedObject[] = [{
        label: 'person', confidence: 0.96,
        bbox: [0, 0, Math.floor(240 * share), 160],
      }];
      const result = detectFire(scene(0, { personShare: share }), state, objects);
      expect(result.smokeEmergency).toBe(false);
    }
  });

  it('does not confirm haze from a single noisy or blurred transition', () => {
    const state = createFireState();
    for (let i = 0; i < 5; i++) detectFire(scene(0), state);
    expect(detectFire(scene(0.9), state).smokeEmergency).toBe(false);
    expect(detectFire(scene(0.9), state).smokeEmergency).toBe(false);
    expect(detectFire(scene(0), state).smokeEmergency).toBe(false);
  });

  it('keeps confirmed haze stable, and clears it only after background recovery', () => {
    const state = createFireState();
    for (let i = 0; i < 5; i++) detectFire(scene(0), state);
    for (const opacity of [0.2, 0.4, 0.65, 0.75, 0.84, 0.9, 0.9, 0.9, 0.9]) {
      detectFire(scene(opacity), state);
    }
    let result = detectFire(scene(0.9), state);
    expect(result.smokeEmergency).toBe(true);
    for (let i = 0; i < 7; i++) {
      result = detectFire(scene(0.9), state);
      expect(result.smokeEmergency).toBe(true);
    }
    for (let i = 0; i < 10; i++) result = detectFire(scene(0), state);
    expect(result.smokeEmergency).toBe(false);
    expect(result.confidence).toBe(0);
  });

  it('refuses to evaluate reliable smoke when the image has almost no visible background', () => {
    const state = createFireState();
    for (let i = 0; i < 5; i++) detectFire(scene(0), state);
    const objects: DetectedObject[] = [{
      label: 'person', confidence: 0.9, bbox: [0, 0, 235, 155],
    }];
    for (let i = 0; i < 10; i++) {
      expect(detectFire(scene(0.9), state, objects).smokeEmergency).toBe(false);
    }
  });
});
