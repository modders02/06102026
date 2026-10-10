import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCameraRegistry } from '@/hooks/useCameraRegistry';
import { CAMERA_HISTORY_LIMIT, loadEventHistory, saveEventHistory } from '@/lib/cameraRegistry';
import { publishCameraSession } from '@/lib/cameraSessions';
import type { DetectionEvent } from '@/types/multicam';

const event = (index: number, type: DetectionEvent['type'] = 'object', extra: Partial<DetectionEvent> = {}): DetectionEvent => ({
  id: `event-${index}`, cameraId: 'history-source', cameraName: 'Front camera', location: 'Entrance',
  type, label: `${type} ${index}`, confidence: 0.9, timestamp: new Date(index * 1000).toISOString(), ...extra,
});

let revoke: ReturnType<typeof vi.fn>;
beforeEach(() => {
  localStorage.clear();
  revoke = vi.fn();
  vi.stubGlobal('URL', class extends URL { static revokeObjectURL = revoke; });
  publishCameraSession('history-source', { video: null, preview: null, previewTimestamp: null, eventPreview: null });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  saveEventHistory({ events: [], alertEvents: [] });
  vi.unstubAllGlobals();
});

describe('bounded camera event histories', () => {
  it('migrates both histories independently before trimming the older combined log', () => {
    const alerts = Array.from({ length: 55 }, (_, index) => event(55 - index, 'fire', { clipUrl: `blob:alert-${55 - index}` }));
    const objects = Array.from({ length: 60 }, (_, index) => event(200 - index, 'object', { clipUrl: `blob:object-${200 - index}` }));
    localStorage.setItem('msd-detection-events-v1', JSON.stringify([...objects, ...alerts]));

    const history = loadEventHistory();
    expect(history.events).toHaveLength(CAMERA_HISTORY_LIMIT);
    expect(history.alertEvents).toHaveLength(CAMERA_HISTORY_LIMIT);
    expect(history.events[0].id).toBe('event-200');
    expect(history.alertEvents.map(item => item.id)).toEqual(alerts.slice(0, 50).map(item => item.id));
    expect(revoke).not.toHaveBeenCalledWith('blob:alert-55');
    expect(revoke).toHaveBeenCalledWith('blob:alert-5');
    expect(revoke).toHaveBeenCalledWith('blob:object-141');
    expect(JSON.parse(localStorage.getItem('msd-detection-events-v1')!)).toHaveLength(50);
    expect(JSON.parse(localStorage.getItem('msd-camera-alerts-v1')!)).toHaveLength(50);
  });

  it('evicts one oldest entry at each cap and preserves alerts through ordinary detections', () => {
    const registry = renderHook(useCameraRegistry);
    const subscriber = renderHook(useCameraRegistry);
    act(() => {
      for (let index = 1; index <= 51; index++) registry.result.current.addEvent(event(index, 'fire', { clipUrl: `blob:clip-${index}` }));
    });
    expect(registry.result.current.events).toEqual([]);
    expect(registry.result.current.alertEvents).toHaveLength(50);
    expect(registry.result.current.alertEvents.map(item => item.id)).toEqual(Array.from({ length: 50 }, (_, index) => `event-${51 - index}`));
    expect(revoke.mock.calls).toEqual([['blob:clip-1']]);

    act(() => {
      for (let index = 100; index < 150; index++) registry.result.current.addEvent(event(index));
    });
    expect(registry.result.current.events.at(-1)?.id).toBe('event-100');
    expect(registry.result.current.alertEvents.at(-1)?.id).toBe('event-2');
    expect(subscriber.result.current.alertEvents).toEqual(registry.result.current.alertEvents);
    expect(revoke.mock.calls).toEqual([['blob:clip-1']]);

    act(() => registry.result.current.addEvent(event(52, 'fire', { clipUrl: 'blob:clip-52' })));
    expect(registry.result.current.alertEvents[0].id).toBe('event-52');
    expect(registry.result.current.alertEvents.at(-1)?.id).toBe('event-3');
    expect(revoke.mock.calls).toEqual([['blob:clip-1'], ['blob:clip-2']]);
  });

  it('attaches completed clips to alerts that have left event history and clears both together', () => {
    const registry = renderHook(useCameraRegistry);
    act(() => {
      registry.result.current.addEvent(event(1, 'multimodal-distress', {
        label: 'Verified distress: Angry + "help"',
      }));
      for (let index = 2; index <= 51; index++) registry.result.current.addEvent(event(index));
      registry.result.current.updateEvent('event-1', { clipUrl: 'blob:finished', clipFile: 'alert.webm' });
    });
    expect(registry.result.current.events.some(item => item.id === 'event-1')).toBe(false);
    expect(registry.result.current.alertEvents[0]).toMatchObject({ id: 'event-1', clipUrl: 'blob:finished' });
    expect(revoke).not.toHaveBeenCalled();

    act(() => registry.result.current.clearEvents());
    expect(registry.result.current.events).toEqual([]);
    expect(registry.result.current.alertEvents).toEqual([]);
    expect(loadEventHistory()).toEqual({ events: [], alertEvents: [] });
    expect(revoke.mock.calls).toEqual([['blob:finished']]);
  });

  it('releases replaced clips once and clips completed after both histories evict the event', () => {
    const registry = renderHook(useCameraRegistry);
    act(() => {
      registry.result.current.addEvent(event(1, 'fire', { clipUrl: 'blob:original' }));
      registry.result.current.updateEvent('event-1', { clipUrl: 'blob:replacement' });
    });
    expect(registry.result.current.events).toEqual([]);
    expect(registry.result.current.alertEvents[0].clipUrl).toBe('blob:replacement');
    expect(revoke.mock.calls).toEqual([['blob:original']]);

    act(() => {
      registry.result.current.clearEvents();
      registry.result.current.updateEvent('event-1', { clipUrl: 'blob:late-completion' });
    });
    expect(revoke.mock.calls).toEqual([['blob:original'], ['blob:replacement'], ['blob:late-completion']]);
    expect(registry.result.current.events).toEqual([]);
    expect(registry.result.current.alertEvents).toEqual([]);
  });

  it('synchronizes both retained histories after a browser storage event', () => {
    const registry = renderHook(useCameraRegistry);
    localStorage.setItem('msd-detection-events-v1', JSON.stringify([event(2)]));
    localStorage.setItem('msd-camera-alerts-v1', JSON.stringify([event(1, 'fire')]));
    act(() => window.dispatchEvent(new Event('storage')));
    expect(registry.result.current.events[0].id).toBe('event-2');
    expect(registry.result.current.alertEvents[0].id).toBe('event-1');
  });

  it('retains and synchronizes the newest histories when snapshot storage exceeds its quota', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage is full.', 'QuotaExceededError');
    });
    const registry = renderHook(useCameraRegistry);
    const subscriber = renderHook(useCameraRegistry);
    act(() => {
      for (let index = 1; index <= 51; index++) registry.result.current.addEvent(event(index, 'fire'));
      for (let index = 100; index < 150; index++) registry.result.current.addEvent(event(index));
    });
    expect(localStorage.getItem('msd-detection-events-v1')).toBeNull();
    expect(registry.result.current.events).toHaveLength(50);
    expect(registry.result.current.alertEvents).toHaveLength(50);
    expect(registry.result.current.events[0].id).toBe('event-149');
    expect(registry.result.current.alertEvents[0].id).toBe('event-51');
    expect(registry.result.current.alertEvents.at(-1)?.id).toBe('event-2');
    expect(subscriber.result.current.events).toEqual(registry.result.current.events);
    expect(subscriber.result.current.alertEvents).toEqual(registry.result.current.alertEvents);

    act(() => registry.result.current.clearEvents());
    expect(subscriber.result.current.events).toEqual([]);
    expect(subscriber.result.current.alertEvents).toEqual([]);
  });
});

describe('priority-only camera alerts', () => {
  it('keeps priority alerts out of Event history', () => {
    const registry = renderHook(useCameraRegistry);
    act(() => registry.result.current.addEvent(event(1, 'fire', {
      label: 'Verified fire',
    })));

    expect(registry.result.current.events).toEqual([]);
    expect(registry.result.current.alertEvents).toHaveLength(1);
    expect(registry.result.current.alertEvents[0]).toMatchObject({
      type: 'fire',
      label: 'Verified fire',
    });
  });

  it('keeps raw audio distress in event history', () => {
    const registry = renderHook(useCameraRegistry);
    act(() => registry.result.current.addEvent(event(1, 'audio-distress', {
      label: 'Safety word: "danger"',
    })));

    expect(registry.result.current.events[0]).toMatchObject({ type: 'audio-distress' });
    expect(registry.result.current.alertEvents).toEqual([]);
  });

  it('does not promote standalone audio even when explicitly marked priority', () => {
    const registry = renderHook(useCameraRegistry);
    act(() => registry.result.current.addEvent(event(1, 'audio-distress', {
      label: 'Wake word: "call 911"',
      priorityScenario: true,
    })));

    expect(registry.result.current.events[0]).toMatchObject({
      type: 'audio-distress',
      priorityScenario: true,
    });
    expect(registry.result.current.alertEvents).toEqual([]);
  });
});

describe('verified multimodal alert history', () => {
  it('retains verified multimodal distress in camera alerts with its snapshot', () => {
    const registry = renderHook(useCameraRegistry);
    act(() => registry.result.current.addEvent(event(1, 'multimodal-distress', {
      label: 'Verified distress: Frightened + "help"',
      snapshot: 'data:image/jpeg;base64,verified',
    })));

    expect(registry.result.current.events).toEqual([]);
    expect(registry.result.current.alertEvents[0]).toMatchObject({
      type: 'multimodal-distress',
      snapshot: 'data:image/jpeg;base64,verified',
    });
  });
});

describe('informational emotion history', () => {
  it.each([
    ['Happy', 0.96],
    ['Sad', 0.91],
    ['Angry', 0.94],
    ['Frightened', 0.93],
    ['Shock', 0.93],
    ['Neutral', 0.95],
    ['Disgust', 0.90],
  ] as const)('stores %s in event history without promoting it to camera alerts', (label, confidence) => {
    const registry = renderHook(useCameraRegistry);
    act(() => registry.result.current.addEvent(event(1, 'emotion', { label, confidence })));

    expect(registry.result.current.events[0]).toMatchObject({ type: 'emotion', label, confidence });
    expect(registry.result.current.alertEvents).toEqual([]);
  });
});

describe('camera event snapshot fallback', () => {
  it('uses the matching camera still and preserves a supplied event frame', () => {
    publishCameraSession('history-source', { preview: 'data:image/jpeg;base64,source', previewTimestamp: 1000 });
    publishCameraSession('history-other', { preview: 'data:image/jpeg;base64,other', previewTimestamp: 1000 });
    const registry = renderHook(useCameraRegistry);
    act(() => {
      registry.result.current.addEvent(event(1, 'fire'));
      registry.result.current.addEvent(event(2, 'fire', { snapshot: 'data:image/jpeg;base64,event' }));
    });
    expect(registry.result.current.alertEvents[1].snapshot).toBe('data:image/jpeg;base64,source');
    expect(registry.result.current.alertEvents[0].snapshot).toBe('data:image/jpeg;base64,event');
  });

  it('captures a ready live source frame before falling back to an older camera still', () => {
    const video = document.createElement('video');
    Object.defineProperties(video, {
      readyState: { value: 2 }, videoWidth: { value: 1920 }, videoHeight: { value: 1080 },
    });
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as ReturnType<HTMLCanvasElement['getContext']>);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,live');
    publishCameraSession('history-source', { video, preview: 'data:image/jpeg;base64,old', previewTimestamp: 1000 });
    const registry = renderHook(useCameraRegistry);
    act(() => registry.result.current.addEvent(event(1, 'multimodal-distress', {
      label: 'Verified distress: Angry + "help"',
    })));
    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 640, 360);
    expect(registry.result.current.alertEvents[0].snapshot).toBe('data:image/jpeg;base64,live');
  });

  it('uses the newest transient source frame ahead of its saved display still', () => {
    publishCameraSession('history-source', {
      preview: 'data:image/jpeg;base64,first', previewTimestamp: 1000,
      eventPreview: 'data:image/jpeg;base64,current',
    });
    const registry = renderHook(useCameraRegistry);
    act(() => registry.result.current.addEvent(event(1, 'multimodal-distress', {
      label: 'Verified distress: Frightened + "help"',
    })));
    expect(registry.result.current.alertEvents[0].snapshot).toBe('data:image/jpeg;base64,current');
  });
});
