import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  detect: vi.fn(),
  load: vi.fn(),
}));

vi.mock('@tensorflow-models/coco-ssd', () => ({
  load: mocks.load,
}));

vi.mock('@tensorflow/tfjs', () => ({}));

import { detectObjects } from '@/lib/detectionEngine';

describe('detection engine indoor filtering', () => {
  beforeEach(() => {
    mocks.detect.mockReset();
    mocks.load.mockReset();
    mocks.load.mockResolvedValue({ detect: mocks.detect });
  });

  it('drops dog cat remote and outdoor detections before they enter the pipeline', async () => {
    mocks.detect.mockResolvedValue([
      { class: 'dog', score: 0.99, bbox: [0, 0, 20, 20] },
      { class: 'cat', score: 0.98, bbox: [20, 0, 20, 20] },
      { class: 'remote', score: 0.97, bbox: [40, 0, 20, 20] },
      { class: 'car', score: 0.96, bbox: [60, 0, 20, 20] },
      { class: 'person', score: 0.95, bbox: [0, 20, 20, 40] },
      { class: 'oven', score: 0.90, bbox: [20, 20, 30, 30] },
      { class: 'cell phone', score: 0.85, bbox: [50, 20, 20, 20] },
    ]);

    const result = await detectObjects(document.createElement('canvas'), 0.4);

    expect(result.map(object => object.label)).toEqual([
      'person',
      'oven',
      'cell phone',
    ]);
    expect(mocks.detect).toHaveBeenCalledWith(expect.anything(), 40, 0.4);
  });
});
