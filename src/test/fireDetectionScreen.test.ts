import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFireState, detectFire } from '@/lib/fireDetection';
import type { DetectedObject } from '@/types/dashboard';

function fireFrame(width = 100, height = 100, box: [number, number, number, number] = [20, 20, 60, 60]) {
  const data = new Uint8ClampedArray(width * height * 4);
  const [bx, by, bw, bh] = box;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const flame = x >= bx && x < bx + bw && y >= by && y < by + bh;
      data[i] = flame ? 255 : 35;
      data[i + 1] = flame ? 150 : 35;
      data[i + 2] = flame ? 40 : 35;
      data[i + 3] = 255;
    }
  }
  return { data, width, height } as ImageData;
}

const device = (
  label: string,
  bbox: [number, number, number, number],
  confidence = 0.95,
): DetectedObject => ({ label, bbox, confidence });

describe('device-screen fire suppression', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-07T00:00:00Z'));
  });

  it.each(['tv', 'cell phone', 'laptop', 'monitor', 'tablet'])(
    'rejects flame-like content displayed inside a %s',
    label => {
      const state = createFireState();
      const result = detectFire(fireFrame(), state, [device(label, [10, 10, 80, 80])]);

      expect(result.screenSuppressed).toBe(true);
      expect(result.fireCandidate).toBe(false);
      expect(result.fireDetected).toBe(false);
      expect(result.detected).toBe(false);
      expect(result.smokeEmergency).toBe(false);
      expect(result.confidence).toBe(0);
      expect(result.rejectedReason).toMatch(/displayed fire inside/);
    },
  );

  it('remembers the screen when object detection misses it on following frames', () => {
    const state = createFireState();
    const first = detectFire(fireFrame(), state, [device('tv', [10, 10, 80, 80])]);
    expect(first.screenSuppressed).toBe(true);

    vi.advanceTimersByTime(6000);
    const missedDeviceFrame = detectFire(fireFrame(), state, []);
    expect(missedDeviceFrame.screenSuppressed).toBe(true);
    expect(missedDeviceFrame.fireCandidate).toBe(false);
    expect(missedDeviceFrame.fireDetected).toBe(false);
  });

  it('does not suppress a real fire region away from the detected screen', () => {
    const state = createFireState();
    const result = detectFire(
      fireFrame(100, 100, [55, 55, 40, 40]),
      state,
      [device('tv', [0, 0, 30, 30])],
    );

    expect(result.screenSuppressed).toBe(false);
    expect(result.fireCandidate).toBe(true);
    expect(result.fireDetected).toBe(true);
  });

  it('expires old screen memory instead of suppressing forever', () => {
    const state = createFireState();
    expect(detectFire(fireFrame(), state, [device('tv', [10, 10, 80, 80])]).screenSuppressed).toBe(true);

    vi.advanceTimersByTime(12001);
    const result = detectFire(fireFrame(), state, []);
    expect(result.screenSuppressed).toBe(false);
    expect(result.fireCandidate).toBe(true);
  });
});
