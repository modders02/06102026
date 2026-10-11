import { describe, expect, it } from 'vitest';
import { createFireState, detectFire } from '@/lib/fireDetection';

function colorFrame(
  width = 120,
  height = 80,
  fireRect: [number, number, number, number] = [42, 20, 34, 42],
): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  const [rx, ry, rw, rh] = fireRect;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const flame = x >= rx && x < rx + rw && y >= ry && y < ry + rh;
      if (flame) {
        data[i] = 245;
        data[i + 1] = 145;
        data[i + 2] = 35;
      } else {
        data[i] = 35;
        data[i + 1] = 70;
        data[i + 2] = 145;
      }
      data[i + 3] = 255;
    }
  }

  return { data, width, height } as ImageData;
}

describe('color fire temporal confirmation', () => {
  it('does not report fire from a single transient fire-colored frame', () => {
    const result = detectFire(colorFrame(), createFireState());

    expect(result.fireCandidate).toBe(true);
    expect(result.fireDetected).toBe(false);
    expect(result.detected).toBe(false);
    expect(result.rejectedReason).toMatch(/awaiting temporal flame confirmation/i);
  });

  it('never promotes a static red/orange object during detector warm-up', () => {
    const state = createFireState();
    const frame = colorFrame();

    const first = detectFire(frame, state);
    const second = detectFire(frame, state);
    const third = detectFire(frame, state);
    const fourth = detectFire(frame, state);

    expect(first.fireDetected).toBe(false);
    expect(second.fireDetected).toBe(false);
    expect(third.fireDetected).toBe(false);
    expect(fourth.fireDetected).toBe(false);
    expect(fourth.detected).toBe(false);
    expect(fourth.rejectedReason).toMatch(/no flicker|static red\/orange/i);
  });

  it('confirms a changing flame-like region after temporal evidence is available', () => {
    const state = createFireState();

    const first = detectFire(colorFrame(120, 80, [44, 22, 28, 36]), state);
    const second = detectFire(colorFrame(120, 80, [40, 18, 38, 45]), state);
    const third = detectFire(colorFrame(120, 80, [46, 20, 30, 40]), state);

    expect(first.fireDetected).toBe(false);
    expect(second.fireDetected).toBe(false);
    expect(third.fireCandidate).toBe(true);
    expect(third.fireDetected).toBe(true);
    expect(third.detected).toBe(true);
  });
});
