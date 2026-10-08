import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({
  computeSaliency: vi.fn(),
  computeSaliencyScore: vi.fn(),
}));

vi.mock('@/lib/saliency', () => ({
  computeSaliency: mocked.computeSaliency,
  computeSaliencyScore: mocked.computeSaliencyScore,
}));

import {
  createMotionAnomalyState,
  detectMotionAnomaly,
} from '@/lib/motionAnomaly';

const frame = (): ImageData => ({
  width: 100,
  height: 100,
  data: new Uint8ClampedArray(100 * 100 * 4),
  colorSpace: 'srgb',
} as ImageData);

const motionMap = (activeRatio: number): ImageData => {
  const data = new Uint8ClampedArray(100 * 100 * 4);
  const active = Math.floor(100 * 100 * activeRatio);
  for (let pixel = 0; pixel < active; pixel++) {
    const index = pixel * 4;
    data[index] = 255;
    data[index + 1] = 255;
    data[index + 2] = 255;
    data[index + 3] = 255;
  }
  return { width: 100, height: 100, data, colorSpace: 'srgb' } as ImageData;
};

describe('validated motion anomalies', () => {
  beforeEach(() => {
    mocked.computeSaliency.mockReset().mockReturnValue(motionMap(0));
    mocked.computeSaliencyScore.mockReset().mockReturnValue(0);
  });

  it('recognizes a tracked person changing from upright to fallen geometry', () => {
    const state = createMotionAnomalyState();
    const previous = frame();
    const current = frame();
    const upright = [{ label: 'person', confidence: 0.95, bbox: [40, 20, 20, 60] as [number, number, number, number] }];
    const fallen = [{ label: 'person', confidence: 0.94, bbox: [30, 60, 60, 25] as [number, number, number, number] }];

    expect(detectMotionAnomaly(previous, null, upright, state).detected).toBe(false);
    const result = detectMotionAnomaly(current, previous, fallen, state);
    expect(result).toMatchObject({
      detected: true,
      kind: 'person-collapse',
      label: 'Possible person collapse',
    });
  });

  it('recognizes a tracked household object moving sharply downward', () => {
    const state = createMotionAnomalyState();
    const previous = frame();
    const current = frame();
    const before = [{ label: 'bottle', confidence: 0.9, bbox: [40, 10, 10, 20] as [number, number, number, number] }];
    const after = [{ label: 'bottle', confidence: 0.88, bbox: [42, 45, 10, 20] as [number, number, number, number] }];

    detectMotionAnomaly(previous, null, before, state);
    expect(detectMotionAnomaly(current, previous, after, state)).toMatchObject({
      detected: true,
      kind: 'object-fall',
      label: 'Possible falling object: bottle',
    });
  });

  it('requires persistent generic rapid motion instead of alerting on one flash', () => {
    mocked.computeSaliency.mockReturnValue(motionMap(0.2));
    mocked.computeSaliencyScore.mockReturnValue(10);
    const state = createMotionAnomalyState();
    const first = frame();
    const second = frame();
    const third = frame();

    detectMotionAnomaly(first, null, [], state);
    expect(detectMotionAnomaly(second, first, [], state).detected).toBe(false);
    expect(detectMotionAnomaly(third, second, [], state)).toMatchObject({
      detected: true,
      kind: 'rapid-motion',
      label: 'Rapid unexplained motion',
    });
  });

  it('fails closed when motion evidence is unavailable', () => {
    mocked.computeSaliency.mockReturnValue(undefined);
    const state = createMotionAnomalyState();
    const first = frame();
    const second = frame();
    detectMotionAnomaly(first, null, [], state);
    expect(detectMotionAnomaly(second, first, [], state).detected).toBe(false);
  });
});
