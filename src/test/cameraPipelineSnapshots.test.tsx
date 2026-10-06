import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCameraPipeline } from '@/hooks/useCameraPipeline';
import { makeCamera } from '@/lib/cameraRegistry';
import { publishCameraSession } from '@/lib/cameraSessions';
import { DEFAULT_SETTINGS } from '@/types/multicam';

const mocked = vi.hoisted(() => ({
  getAudioEvents: vi.fn(), getCameraSnapshot: vi.fn(), detectObjects: vi.fn(), detectFire: vi.fn(),
  analyzeFace: async () => {}, distress: { hasFace: false, distressLevel: 'none', distressScore: 0 },
}));
vi.mock('hls.js', () => ({ default: class { static isSupported() { return false; } } }));
vi.mock('@/lib/detectionEngine', () => ({ loadDetector: async () => {}, detectObjects: mocked.detectObjects }));
vi.mock('@/lib/saliency', () => ({ computeSaliency: () => ({}), computeSaliencyScore: () => 80 }));
vi.mock('@/lib/fireDetection', () => ({ createFireState: () => ({}), detectFire: mocked.detectFire }));
vi.mock('@/hooks/useFaceDistress', () => ({
  useFaceDistress: () => ({
    ready: false, distress: mocked.distress, analyze: mocked.analyzeFace,
  }),
}));
vi.mock('@/lib/multiCamServer', () => ({
  getAudioEvents: mocked.getAudioEvents, getCameraSnapshot: mocked.getCameraSnapshot,
  describeAudioStatus: () => ({ message: 'Listening', tone: 'ok' }),
}));

const safetyEvent = { timestamp: '2026-10-04T00:00:01Z', transcript: 'help me', keyword: 'help', confidence: 0.99 };
let drawImage: ReturnType<typeof vi.fn>;
beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  vi.stubGlobal('RTCPeerConnection', undefined);
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1280, height: 720, close: vi.fn() })));
  mocked.getAudioEvents.mockReset().mockResolvedValue({ events: [], status: null });
  mocked.getCameraSnapshot.mockReset().mockResolvedValue({ blob: new Blob(['jpeg']), timestamp: Date.now() });
  mocked.detectObjects.mockReset().mockResolvedValue([]);
  mocked.detectFire.mockReset().mockReturnValue({ fireDetected: false, smokeEmergency: false, confidence: 0, smokeRatio: 0 });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,current');
  drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage, getImageData: () => ({ width: 320, height: 180, data: new Uint8ClampedArray(320 * 180 * 4) }),
  } as unknown as ReturnType<HTMLCanvasElement['getContext']>);
  publishCameraSession('snapshot-pipeline', { video: null, preview: null, previewTimestamp: null });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('pipeline event snapshots', () => {
  it('captures a still for every visual detection type, including objects, humans, and saliency', async () => {
    mocked.detectObjects.mockResolvedValue([{ label: 'person', confidence: 0.9, bbox: [0, 0, 20, 20] }]);
    mocked.detectFire.mockReturnValue({ fireDetected: true, smokeEmergency: true, confidence: 0.9, smokeRatio: 0.8 });
    const onEvent = vi.fn();
    renderHook(() => useCameraPipeline({
      camera: makeCamera({ id: 'snapshot-pipeline' }), settings: DEFAULT_SETTINGS, playbackEnabled: false, onEvent,
    }));
    await act(async () => {});
    const events = onEvent.mock.calls.map(([event]) => event);
    expect(events.map(event => event.type)).toEqual(['object', 'human', 'fire', 'smoke', 'saliency']);
    for (const event of events) expect(event).toMatchObject({ cameraId: 'snapshot-pipeline', snapshot: 'data:image/jpeg;base64,current' });
  });

  it('includes the newest background camera still for audio alerts while AI is disabled', async () => {
    const onEvent = vi.fn();
    renderHook(() => useCameraPipeline({
      camera: makeCamera({ id: 'snapshot-pipeline', aiEnabled: false }), settings: DEFAULT_SETTINGS, playbackEnabled: false, onEvent,
    }));
    await act(async () => {});
    mocked.getAudioEvents.mockResolvedValueOnce({ events: [safetyEvent], status: null });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(mocked.detectObjects).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'audio-distress', cameraId: 'snapshot-pipeline', snapshot: 'data:image/jpeg;base64,current',
    }));
  });

  it('captures a live audio alert frame while AI is disabled', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(2);
    vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(1280);
    vi.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockReturnValue(720);
    mocked.getAudioEvents.mockResolvedValueOnce({ events: [safetyEvent], status: null });
    const onEvent = vi.fn();
    const pipeline = renderHook(() => useCameraPipeline({
      camera: makeCamera({ id: 'snapshot-pipeline', aiEnabled: false }), settings: DEFAULT_SETTINGS,
      managedVideo: true, playbackEnabled: true, onEvent,
    }));
    await act(async () => {});
    expect(mocked.detectObjects).not.toHaveBeenCalled();
    expect(mocked.getCameraSnapshot).not.toHaveBeenCalled();
    expect(drawImage).toHaveBeenCalledWith(pipeline.result.current.videoRef.current, 0, 0, 640, 360);
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'audio-distress', cameraId: 'snapshot-pipeline', snapshot: 'data:image/jpeg;base64,current',
    }));
  });
});
