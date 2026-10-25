import { beforeEach, describe, expect, it } from 'vitest';
import { loadEventHistory, saveEventHistory } from '@/lib/cameraRegistry';
import type { DetectionEvent } from '@/types/multicam';

const event = (id: string, type: DetectionEvent['type'], label: string): DetectionEvent => ({
  id, cameraId: 'slot-1', cameraName: 'Camera 1', location: 'Hall',
  type, label, confidence: 0.99, timestamp: '2026-10-25T19:00:00+08:00',
});

describe('Event History emotion filtering', () => {
  beforeEach(() => localStorage.clear());

  it('does not persist happy or other standalone facial expressions', () => {
    const result = saveEventHistory({
      events: [
        event('happy', 'emotion', 'Happy'),
        event('sad', 'emotion', 'Sad'),
        event('fire', 'fire', 'Fire detected'),
      ],
      alertEvents: [],
    });
    expect(result.events.map(item => item.id)).toEqual(['fire']);
    expect(loadEventHistory().events.map(item => item.id)).toEqual(['fire']);
  });

  it('migrates previously stored Happy entries out of history', () => {
    localStorage.setItem('msd-detection-events-v1', JSON.stringify([
      event('happy', 'emotion', 'Happy'),
      event('fire', 'fire', 'Fire detected'),
    ]));
    localStorage.setItem('msd-camera-alerts-v1', '[]');
    const result = loadEventHistory();
    expect(result.events.map(item => item.id)).toEqual(['fire']);
    expect(JSON.parse(localStorage.getItem('msd-detection-events-v1') || '[]')
      .map((item: DetectionEvent) => item.id)).toEqual(['fire']);
  });
});
