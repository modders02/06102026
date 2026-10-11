import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRIORITY_OBJECTS,
  INDOOR_OBJECTS,
  isRelevantIndoorObject,
} from '@/types/dashboard';

describe('relevant indoor object filter', () => {
  it.each([
    'dog',
    'cat',
    'remote',
    'bird',
    'horse',
    'car',
    'motorcycle',
    'bicycle',
    'bus',
    'truck',
    'airplane',
    'train',
    'boat',
    'traffic light',
    'fire hydrant',
    'stop sign',
    'parking meter',
    'frisbee',
    'sports ball',
    'kite',
    'skateboard',
    'surfboard',
    'tennis racket',
    'teddy bear',
    'toothbrush',
    'hair drier',
  ])('filters irrelevant class %s', label => {
    expect(isRelevantIndoorObject(label)).toBe(false);
    expect(INDOOR_OBJECTS).not.toContain(label);
  });

  it.each([
    'person',
    'chair',
    'couch',
    'bed',
    'dining table',
    'tv',
    'laptop',
    'cell phone',
    'keyboard',
    'mouse',
    'bottle',
    'cup',
    'bowl',
    'knife',
    'scissors',
    'microwave',
    'oven',
    'toaster',
    'sink',
    'refrigerator',
    'backpack',
    'handbag',
    'suitcase',
  ])('keeps relevant indoor class %s', label => {
    expect(isRelevantIndoorObject(label)).toBe(true);
    expect(INDOOR_OBJECTS).toContain(label);
  });

  it('keeps every default priority object inside the app-visible indoor whitelist', () => {
    expect(DEFAULT_PRIORITY_OBJECTS.every(isRelevantIndoorObject)).toBe(true);
  });
});
