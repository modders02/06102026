import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCameraRegistry } from '@/hooks/useCameraRegistry';
import { CAMERA_HISTORY_LIMIT, loadEventHistory, saveEventHistory } from '@/lib/cameraRegistry';
import { publishCameraSession } from '@/lib/cameraSessions';
import type { DetectionEvent } from '@/types/multicam';

const event = (
  index: number,
  type: DetectionEvent['type'] = 'object',
  extra: Partial<DetectionEvent> = {},
): DetectionEvent => {
  const label = extra.label ?? (type === 'object' ? 'chair' : `${type} ${index}`);
  const distress = /^Verified distress: (Angry|Frightened) \+ "help"$/.exec(label);
  const defaultValidation: DetectionEvent['alertValidation'] | undefined =
    type === 'fire'
      ? { status: 'accepted', reason: 'validated fire audio + visual fire', keyword: 'fire', emotion: 'visual fire' }
      : type === 'smoke'
        ? { status: 'accepted', reason: 'validated visual smoke', keyword: '', emotion: 'visual smoke' }
        : type === 'multimodal-distress' && distress
        ? { status: 'accepted', reason: 'validated help + face', keyword: 'help', emotion: distress[1] }
        : type === 'motion-anomaly' && /person collapse/i.test(label)
          ? { status: 'accepted', reason: 'validated person collapse', keyword: '', emotion: 'motion' }
          : type === 'attention-alert' && /priority object/i.test(label)
            ? { status: 'accepted', reason: 'validated priority object', keyword: '', emotion: 'priority object' }
            : undefined;

  return {
    id: `event-${index}`,
    cameraId: 'history-source',
    cameraName: 'Front camera',
    location: 'Entrance',
    type,
    label,
    confidence: 0.9,
    fireConfirmed: type === 'fire' ? true : undefined,
    fireRegionRatio: type === 'fire' ? 0.15 : undefined,
    smokeConfirmed: type === 'smoke' ? true : undefined,
    alertValidation: defaultValidation,
    timestamp: new Date(index * 1000).toISOString(),
    ...extra,
  };
};

let revoke: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  revoke = vi.fn();
  vi.stubGlobal('URL', class extends URL { static revokeObjectURL = revoke; });
  publishCameraSession('history-source', {
    video: null,
    preview: null,
    previewTimestamp: null,
    eventPreview: null,
    runtime: null,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  saveEventHistory({ events: [], alertEvents: [] });
  vi.unstubAllGlobals();
});

describe('single active Camera Alert with bounded Event History', () => {
  it('retains older fire records without size evidence as history with their images intact', () => {
    const legacy = event(1, 'fire', { fireRegionRatio: undefined, snapshot: 'data:image/jpeg;base64,legacy' });
    localStorage.setItem('msd-camera-alerts-v1', JSON.stringify([legacy]));
    const history = loadEventHistory();
    expect(history.alertEvents).toHaveLength(0);
    expect(history.events).toContainEqual(expect.objectContaining({
      id: legacy.id, priorityScenario: false, snapshot: legacy.snapshot,
    }));
  });

  it('purges legacy irrelevant object detections while keeping relevant indoor history', () => {
    const legacy = [
      event(1, 'object', { label: 'dog' }),
      event(2, 'object', { label: 'cat' }),
      event(3, 'object', { label: 'remote' }),
      event(4, 'object', { label: 'car' }),
      event(5, 'object', { label: 'person' }),
      event(6, 'object', { label: 'oven' }),
    ];
    localStorage.setItem('msd-detection-events-v1', JSON.stringify(legacy));
    localStorage.setItem('msd-camera-alerts-v1', JSON.stringify([]));

    const history = loadEventHistory();

    expect(history.events.map(item => item.label)).toEqual(['oven', 'person']);
    expect(JSON.parse(localStorage.getItem('msd-detection-events-v1')!)
      .map((item: DetectionEvent) => item.label)).toEqual(['oven', 'person']);
  });


  it('migrates legacy stacked alerts to one active alert and historical records', () => {
    const alerts = [
      event(30, 'fire', { clipUrl: 'blob:alert-30' }),
      event(20, 'fire', { clipUrl: 'blob:alert-20' }),
      event(10, 'fire', { clipUrl: 'blob:alert-10' }),
    ];
    const objects = [event(40), event(35)];
    localStorage.setItem('msd-detection-events-v1', JSON.stringify(objects));
    localStorage.setItem('msd-camera-alerts-v1', JSON.stringify(alerts));

    const history = loadEventHistory();

    expect(history.alertEvents).toHaveLength(1);
    expect(history.alertEvents[0].id).toBe('event-30');
    expect(history.events.map(item => item.id)).toEqual([
      'event-40', 'event-35', 'event-20', 'event-10',
    ]);
    expect(history.events.find(item => item.id === 'event-20')?.priorityScenario).toBe(false);
    expect(JSON.parse(localStorage.getItem('msd-camera-alerts-v1')!)).toHaveLength(1);
  });

  it('replaces the active alert and archives the previous accepted trigger', () => {
    const registry = renderHook(useCameraRegistry);

    act(() => registry.result.current.addEvent(event(1, 'fire', {
      label: 'First fire',
      snapshot: 'data:image/jpeg;base64,first',
    })));
    expect(registry.result.current.alertEvents.map(item => item.id)).toEqual(['event-1']);
    expect(registry.result.current.events).toEqual([]);

    act(() => registry.result.current.addEvent(event(2, 'fire', {
      label: 'Second fire',
      snapshot: 'data:image/jpeg;base64,second',
    })));

    expect(registry.result.current.alertEvents.map(item => item.id)).toEqual(['event-2']);
    expect(registry.result.current.events[0]).toMatchObject({
      id: 'event-1',
      label: 'First fire',
      priorityScenario: false,
      snapshot: 'data:image/jpeg;base64,first',
    });
  });

  it('keeps Event History bounded while Camera Alert remains a single current record', () => {
    const registry = renderHook(useCameraRegistry);
    act(() => {
      for (let index = 1; index <= 60; index++) {
        registry.result.current.addEvent(event(index, 'fire', {
          snapshot: `data:image/jpeg;base64,fire-${index}`,
        }));
      }
    });

    expect(registry.result.current.alertEvents).toHaveLength(1);
    expect(registry.result.current.alertEvents[0].id).toBe('event-60');
    expect(registry.result.current.events).toHaveLength(CAMERA_HISTORY_LIMIT);
    expect(registry.result.current.events[0].id).toBe('event-59');
    expect(registry.result.current.events.at(-1)?.id).toBe('event-10');
  });

  it('archives the active alert explicitly when live validation is no longer accepted', () => {
    const registry = renderHook(useCameraRegistry);
    act(() => registry.result.current.addEvent(event(1, 'multimodal-distress', {
      label: 'Verified distress: Angry + "help"',
      snapshot: 'data:image/jpeg;base64,verified',
    })));

    act(() => registry.result.current.archiveActiveAlert('event-1'));

    expect(registry.result.current.alertEvents).toEqual([]);
    expect(registry.result.current.events[0]).toMatchObject({
      id: 'event-1',
      priorityScenario: false,
      snapshot: 'data:image/jpeg;base64,verified',
    });
  });

  it('updates a completed recording after its alert has moved into Event History', () => {
    const registry = renderHook(useCameraRegistry);
    act(() => {
      registry.result.current.addEvent(event(1, 'fire'));
      registry.result.current.addEvent(event(2, 'fire'));
      registry.result.current.updateEvent('event-1', {
        clipUrl: 'blob:finished',
        clipFile: 'alert.webm',
      });
    });

    expect(registry.result.current.alertEvents[0].id).toBe('event-2');
    expect(registry.result.current.events.find(item => item.id === 'event-1')).toMatchObject({
      clipUrl: 'blob:finished',
      clipFile: 'alert.webm',
    });
    expect(revoke).not.toHaveBeenCalled();
  });

  it('routes ongoing updates to one history copy while preserving the accepted trigger', () => {
    const registry = renderHook(useCameraRegistry);
    const trigger = event(1, 'fire', { snapshot: 'data:image/jpeg;base64,accepted' });
    act(() => registry.result.current.addEvent(trigger));
    const acceptedAlert = registry.result.current.alertEvents[0];

    act(() => registry.result.current.updateEvent('event-1', {
      clipUrl: 'blob:finished',
      clipFile: 'accepted.webm',
    }));
    act(() => registry.result.current.updateEvent('event-1', {
      label: 'Later detection update',
      snapshot: 'data:image/jpeg;base64,later',
      priorityScenario: true,
      alertValidation: { status: 'rejected', reason: 'Later rejection', keyword: '', emotion: '' },
    }));

    expect(registry.result.current.alertEvents[0]).toBe(acceptedAlert);
    expect(registry.result.current.alertEvents[0]).toEqual(trigger);
    expect(registry.result.current.events).toHaveLength(1);
    expect(registry.result.current.events[0]).toMatchObject({
      id: 'event-1',
      label: 'Later detection update',
      snapshot: 'data:image/jpeg;base64,later',
      priorityScenario: false,
      clipUrl: 'blob:finished',
      clipFile: 'accepted.webm',
      alertValidation: { status: 'rejected' },
    });
    expect(revoke).not.toHaveBeenCalled();
  });

  it.each(['replace', 'archive'] as const)('preserves completed history updates when the active alert is %s', action => {
    const registry = renderHook(useCameraRegistry);
    act(() => {
      registry.result.current.addEvent(event(1, 'fire'));
      registry.result.current.updateEvent('event-1', { clipUrl: 'blob:finished', clipFile: 'accepted.webm' });
      if (action === 'replace') registry.result.current.addEvent(event(2, 'fire'));
      else registry.result.current.archiveActiveAlert('event-1');
    });

    expect(registry.result.current.events.filter(item => item.id === 'event-1')).toHaveLength(1);
    expect(registry.result.current.events.find(item => item.id === 'event-1')).toMatchObject({
      priorityScenario: false,
      clipUrl: 'blob:finished',
      clipFile: 'accepted.webm',
    });
    expect(revoke).not.toHaveBeenCalled();
  });

  it('reloads the completed history copy separately from the original accepted alert', () => {
    const registry = renderHook(useCameraRegistry);
    act(() => {
      registry.result.current.addEvent(event(1, 'fire', { snapshot: 'data:image/jpeg;base64,accepted' }));
      registry.result.current.updateEvent('event-1', { clipUrl: 'blob:finished', clipFile: 'accepted.webm' });
    });
    // Reformat the persisted values so the next registry reads storage instead
    // of the in-memory cache, as a new browser session would.
    for (const key of ['msd-detection-events-v1', 'msd-camera-alerts-v1']) {
      localStorage.setItem(key, JSON.stringify(JSON.parse(localStorage.getItem(key)!), null, 2));
    }

    const reloaded = renderHook(useCameraRegistry);

    expect(reloaded.result.current.alertEvents[0]).toMatchObject({ id: 'event-1', snapshot: 'data:image/jpeg;base64,accepted' });
    expect(reloaded.result.current.alertEvents[0].clipUrl).toBeUndefined();
    expect(reloaded.result.current.events[0]).toMatchObject({
      id: 'event-1',
      priorityScenario: false,
      clipUrl: 'blob:finished',
      clipFile: 'accepted.webm',
    });
  });

  it('ignores repeated active and archived trigger IDs without recapturing or reopening them', () => {
    publishCameraSession('history-source', { eventPreview: 'data:image/jpeg;base64,first' });
    const registry = renderHook(useCameraRegistry);
    act(() => registry.result.current.addEvent(event(1, 'fire')));
    const acceptedAlert = registry.result.current.alertEvents[0];
    publishCameraSession('history-source', { eventPreview: 'data:image/jpeg;base64,later' });

    act(() => registry.result.current.addEvent(event(1, 'fire', { clipUrl: 'blob:duplicate' })));
    expect(registry.result.current.alertEvents[0]).toBe(acceptedAlert);
    expect(registry.result.current.alertEvents[0].snapshot).toBe('data:image/jpeg;base64,first');
    expect(registry.result.current.events).toEqual([]);
    expect(revoke).toHaveBeenCalledWith('blob:duplicate');

    act(() => {
      registry.result.current.updateEvent('event-1', { clipUrl: 'blob:finished' });
      registry.result.current.addEvent(event(2, 'fire'));
      registry.result.current.addEvent(event(1, 'fire', { label: 'Stale repeated trigger' }));
    });
    expect(registry.result.current.alertEvents[0].id).toBe('event-2');
    expect(registry.result.current.events).toHaveLength(1);
    expect(registry.result.current.events[0]).toMatchObject({ id: 'event-1', label: 'fire 1', clipUrl: 'blob:finished' });
    expect(revoke).not.toHaveBeenCalledWith('blob:finished');
  });

  it('keeps delayed accepted triggers in history without replacing a newer active trigger', () => {
    const registry = renderHook(useCameraRegistry);
    act(() => {
      registry.result.current.addEvent(event(2, 'fire', { snapshot: 'data:image/jpeg;base64,newer' }));
      registry.result.current.addEvent(event(1, 'fire', { snapshot: 'data:image/jpeg;base64,delayed' }));
    });

    expect(registry.result.current.alertEvents[0]).toMatchObject({ id: 'event-2', snapshot: 'data:image/jpeg;base64,newer' });
    expect(registry.result.current.events[0]).toMatchObject({ id: 'event-1', priorityScenario: false });
  });

  it('retains clips referenced by either copy and revokes them when both copies are cleared', () => {
    const registry = renderHook(useCameraRegistry);
    act(() => {
      registry.result.current.addEvent(event(1, 'fire', { clipUrl: 'blob:trigger' }));
      registry.result.current.updateEvent('event-1', { clipUrl: 'blob:history' });
      registry.result.current.updateEvent('event-1', { clipUrl: 'blob:replacement' });
    });

    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith('blob:history');
    expect(registry.result.current.alertEvents[0].clipUrl).toBe('blob:trigger');
    expect(registry.result.current.events[0].clipUrl).toBe('blob:replacement');

    act(() => registry.result.current.clearEvents());
    expect(revoke.mock.calls.map(call => call[0])).toEqual(['blob:history', 'blob:replacement', 'blob:trigger']);
    act(() => registry.result.current.updateEvent('event-1', { clipUrl: 'blob:finished-after-clear' }));
    expect(revoke).toHaveBeenCalledWith('blob:finished-after-clear');
    expect(registry.result.current.events).toEqual([]);
    expect(registry.result.current.alertEvents).toEqual([]);
  });

  it('revokes an updated history clip when bounded history evicts it without changing the active trigger', () => {
    const registry = renderHook(useCameraRegistry);
    act(() => {
      registry.result.current.addEvent(event(1, 'fire'));
      registry.result.current.updateEvent('event-1', { clipUrl: 'blob:evicted-history' });
      for (let index = 2; index <= CAMERA_HISTORY_LIMIT + 1; index++) registry.result.current.addEvent(event(index));
    });

    expect(registry.result.current.alertEvents[0].id).toBe('event-1');
    expect(registry.result.current.events).toHaveLength(CAMERA_HISTORY_LIMIT);
    expect(registry.result.current.events.some(item => item.id === 'event-1')).toBe(false);
    expect(revoke).toHaveBeenCalledWith('blob:evicted-history');
  });

  it('deduplicates stored alert IDs and preserves completed history copies during migration', () => {
    localStorage.setItem('msd-detection-events-v1', JSON.stringify([
      event(1, 'fire', { priorityScenario: false, clipUrl: 'blob:finished' }),
    ]));
    localStorage.setItem('msd-camera-alerts-v1', JSON.stringify([
      event(2, 'fire'), event(2, 'fire', { clipUrl: 'blob:duplicate' }), event(1, 'fire'),
    ]));

    const history = loadEventHistory();

    expect(history.alertEvents.map(item => item.id)).toEqual(['event-2']);
    expect(history.events).toHaveLength(1);
    expect(history.events[0]).toMatchObject({ id: 'event-1', clipUrl: 'blob:finished', priorityScenario: false });
    expect(revoke).toHaveBeenCalledWith('blob:duplicate');
    expect(revoke).not.toHaveBeenCalledWith('blob:finished');
  });

  it('synchronizes the active alert and Event History after a storage event', () => {
    const registry = renderHook(useCameraRegistry);
    localStorage.setItem('msd-detection-events-v1', JSON.stringify([event(2)]));
    localStorage.setItem('msd-camera-alerts-v1', JSON.stringify([event(1, 'fire')]));
    act(() => window.dispatchEvent(new Event('storage')));

    expect(registry.result.current.events[0].id).toBe('event-2');
    expect(registry.result.current.alertEvents).toHaveLength(1);
    expect(registry.result.current.alertEvents[0].id).toBe('event-1');
  });

  it('retains in-memory history if browser storage writes fail', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage is full.', 'QuotaExceededError');
    });
    const registry = renderHook(useCameraRegistry);
    const subscriber = renderHook(useCameraRegistry);

    act(() => {
      registry.result.current.addEvent(event(1, 'fire'));
      registry.result.current.addEvent(event(2, 'fire'));
      for (let index = 100; index < 150; index++) registry.result.current.addEvent(event(index));
    });

    expect(registry.result.current.alertEvents).toHaveLength(1);
    expect(registry.result.current.alertEvents[0].id).toBe('event-2');
    expect(registry.result.current.events).toHaveLength(CAMERA_HISTORY_LIMIT);
    expect(subscriber.result.current.events).toEqual(registry.result.current.events);
    expect(subscriber.result.current.alertEvents).toEqual(registry.result.current.alertEvents);
  });
});

describe('validation gate for Camera Alert', () => {
  it('stores REJECTED detections without a snapshot and never in Camera Alert', () => {
    const registry = renderHook(useCameraRegistry);
    act(() => registry.result.current.addEvent(event(1, 'multimodal-distress', {
      label: 'Verified distress: Angry + "help"',
      snapshot: 'data:image/jpeg;base64,must-not-survive',
      alertValidation: {
        status: 'rejected',
        reason: 'Current camera expression is Happy.',
        keyword: 'help',
        emotion: 'Happy',
      },
    })));

    expect(registry.result.current.alertEvents).toEqual([]);
    expect(registry.result.current.events[0]).toMatchObject({
      type: 'multimodal-distress',
      alertValidation: { status: 'rejected' },
    });
    expect(registry.result.current.events[0].snapshot).toBeUndefined();
  });

  it('keeps unconfirmed fire out of Camera Alert and strips its snapshot', () => {
    const registry = renderHook(useCameraRegistry);
    act(() => registry.result.current.addEvent(event(1, 'fire', {
      fireConfirmed: false,
      snapshot: 'data:image/jpeg;base64,false-fire',
      alertValidation: {
        status: 'accepted',
        reason: 'candidate only',
        keyword: '',
        emotion: 'visual fire candidate',
      },
    })));

    expect(registry.result.current.alertEvents).toEqual([]);
    expect(registry.result.current.events[0]).toMatchObject({
      type: 'fire',
      fireConfirmed: false,
      priorityScenario: false,
    });
    expect(registry.result.current.events[0].snapshot).toBeUndefined();
  });

  it('keeps unconfirmed smoke out of Camera Alert and strips its snapshot', () => {
    const registry = renderHook(useCameraRegistry);
    act(() => registry.result.current.addEvent(event(1, 'smoke', {
      smokeConfirmed: false,
      snapshot: 'data:image/jpeg;base64,false-smoke',
      alertValidation: {
        status: 'accepted',
        reason: 'candidate only',
        keyword: '',
        emotion: 'visual smoke candidate',
      },
    })));

    expect(registry.result.current.alertEvents).toEqual([]);
    expect(registry.result.current.events[0]).toMatchObject({
      type: 'smoke',
      smokeConfirmed: false,
      priorityScenario: false,
    });
    expect(registry.result.current.events[0].snapshot).toBeUndefined();
  });

  it('keeps raw audio distress in Event History even when marked priority by a caller', () => {
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

  it('keeps informational emotions in Event History only', () => {
    const registry = renderHook(useCameraRegistry);
    act(() => registry.result.current.addEvent(event(1, 'emotion', {
      label: 'Happy',
      confidence: 0.96,
    })));

    expect(registry.result.current.events[0]).toMatchObject({
      type: 'emotion',
      label: 'Happy',
    });
    expect(registry.result.current.alertEvents).toEqual([]);
  });
});

describe('exact trigger snapshot retention', () => {
  it('captures a matching still for the alert and preserves it after the next trigger', () => {
    publishCameraSession('history-source', {
      preview: 'data:image/jpeg;base64,source',
      previewTimestamp: 1000,
    });
    const registry = renderHook(useCameraRegistry);

    act(() => registry.result.current.addEvent(event(1, 'fire')));
    expect(registry.result.current.alertEvents[0].snapshot).toBe('data:image/jpeg;base64,source');

    act(() => registry.result.current.addEvent(event(2, 'fire', {
      snapshot: 'data:image/jpeg;base64,second',
    })));

    expect(registry.result.current.alertEvents[0].snapshot).toBe('data:image/jpeg;base64,second');
    expect(registry.result.current.events.find(item => item.id === 'event-1')?.snapshot)
      .toBe('data:image/jpeg;base64,source');
  });

  it('captures a ready live source frame for the accepted trigger', () => {
    const video = document.createElement('video');
    Object.defineProperties(video, {
      readyState: { value: 2 },
      videoWidth: { value: 1920 },
      videoHeight: { value: 1080 },
    });
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage,
    } as unknown as ReturnType<HTMLCanvasElement['getContext']>);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL')
      .mockReturnValue('data:image/jpeg;base64,live');
    publishCameraSession('history-source', {
      video,
      preview: 'data:image/jpeg;base64,old',
      previewTimestamp: 1000,
    });
    const registry = renderHook(useCameraRegistry);

    act(() => registry.result.current.addEvent(event(1, 'multimodal-distress', {
      label: 'Verified distress: Angry + "help"',
    })));

    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 640, 360);
    expect(registry.result.current.alertEvents[0].snapshot)
      .toBe('data:image/jpeg;base64,live');
  });

  it('uses the newest transient source frame for the exact accepted trigger', () => {
    publishCameraSession('history-source', {
      preview: 'data:image/jpeg;base64,first',
      previewTimestamp: 1000,
      eventPreview: 'data:image/jpeg;base64,current',
    });
    const registry = renderHook(useCameraRegistry);

    act(() => registry.result.current.addEvent(event(1, 'multimodal-distress', {
      label: 'Verified distress: Frightened + "help"',
    })));

    expect(registry.result.current.alertEvents[0].snapshot)
      .toBe('data:image/jpeg;base64,current');
  });
});
