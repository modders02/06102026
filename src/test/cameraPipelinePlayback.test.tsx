import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCameraPipeline } from '@/hooks/useCameraPipeline';
import { makeCamera } from '@/lib/cameraRegistry';
import { DEFAULT_SETTINGS } from '@/types/multicam';

interface MockRtc {
  callbacks: { onStream: (stream: MediaStream) => void; onError: (error: Error) => void };
  close: ReturnType<typeof vi.fn>;
}
const mocked = vi.hoisted(() => ({
  rtc: [] as MockRtc[],
  openCameraWebRtc: vi.fn(),
}));
vi.mock('@/lib/cameraWebRtc', () => ({ openCameraWebRtc: mocked.openCameraWebRtc }));
vi.mock('@/lib/detectionEngine', () => ({ loadDetector: async () => {}, detectObjects: async () => [] }));
vi.mock('@/lib/fireDetection', () => ({ createFireState: () => ({}) }));
vi.mock('@/hooks/useFaceDistress', () => ({ useFaceDistress: () => ({ ready: false, distress: {}, analyze: async () => {} }) }));
vi.mock('@/lib/multiCamServer', () => ({
  getAudioEvents: async () => ({ events: [], status: null }),
  getCameraSnapshot: vi.fn(), describeAudioStatus: () => ({ message: 'Listening', tone: 'ok' }),
}));

let decoded: number;
let cancelFrame: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('RTCPeerConnection', function Peer() {});
  decoded = 0;
  mocked.rtc.length = 0;
  mocked.openCameraWebRtc.mockReset().mockImplementation((_url, callbacks: MockRtc['callbacks']) => {
    const session = { callbacks, close: vi.fn() };
    mocked.rtc.push(session);
    return session;
  });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(2);
  vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(1280);
  vi.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockReturnValue(720);
  vi.stubGlobal('performance', { now: () => Date.now() });
  Object.defineProperty(HTMLVideoElement.prototype, 'getVideoPlaybackQuality', {
    configurable: true, value: () => ({ totalVideoFrames: decoded }),
  });
  Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', { configurable: true, value: vi.fn(() => 1) });
  cancelFrame = vi.fn();
  Object.defineProperty(HTMLVideoElement.prototype, 'cancelVideoFrameCallback', { configurable: true, value: cancelFrame });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (HTMLVideoElement.prototype as Partial<HTMLVideoElement>).getVideoPlaybackQuality;
  delete (HTMLVideoElement.prototype as Partial<HTMLVideoElement>).requestVideoFrameCallback;
  delete (HTMLVideoElement.prototype as Partial<HTMLVideoElement>).cancelVideoFrameCallback;
});

function open() {
  return renderHook(() => useCameraPipeline({
    camera: makeCamera({ id: 'playback', aiEnabled: false }), settings: DEFAULT_SETTINGS, managedVideo: true,
  }));
}

function deliverStream(session = mocked.rtc[0]) {
  act(() => session.callbacks.onStream({ getTracks: () => [] } as unknown as MediaStream));
}

describe('camera pipeline realtime playback lifecycle', () => {
  it('reports live decoder FPS even when compositor callbacks never arrive', async () => {
    const hook = open();
    expect(hook.result.current.runtime.status).toBe('connecting');
    expect(mocked.openCameraWebRtc).toHaveBeenCalledOnce();
    expect(hook.result.current.runtime.transport).toBe('webrtc');
    decoded = 30;
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(hook.result.current.runtime).toMatchObject({ status: 'online', fps: 30, transport: 'webrtc' });
  });

  it('reconnects a frozen realtime stream instead of changing transports', async () => {
    const hook = open();
    deliverStream();
    decoded = 30;
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(hook.result.current.runtime).toMatchObject({ status: 'online', fps: 30, transport: 'webrtc' });
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(mocked.rtc[0].close).toHaveBeenCalledOnce();
    expect(hook.result.current.runtime).toMatchObject({ status: 'connecting', fps: 0, transport: 'webrtc' });
    expect(hook.result.current.runtime.playbackWarning).toMatch(/Realtime video stalled/);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(mocked.rtc).toHaveLength(2);
    decoded = 60;
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(hook.result.current.runtime).toMatchObject({ status: 'online', fps: 30, transport: 'webrtc' });
  });

  it('retries realtime playback when no frame arrives and cancels work on unmount', async () => {
    const hook = open();
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(mocked.rtc).toHaveLength(2);
    expect(mocked.rtc[0].close).toHaveBeenCalledOnce();
    expect(hook.result.current.runtime.transport).toBe('webrtc');
    expect(hook.result.current.runtime.playbackWarning).toMatch(/did not start/);
    hook.unmount();
    expect(mocked.rtc[1].close).toHaveBeenCalledOnce();
    expect(cancelFrame).toHaveBeenCalledWith(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    expect(mocked.rtc).toHaveLength(2);
  });

  it('reports unsupported realtime playback without opening another transport', async () => {
    vi.stubGlobal('RTCPeerConnection', undefined);
    let hook!: ReturnType<typeof open>;
    await act(async () => { hook = open(); });
    expect(hook.result.current.runtime).toMatchObject({
      status: 'error', error: 'Realtime playback is not supported in this browser.',
    });
    expect(mocked.openCameraWebRtc).not.toHaveBeenCalled();
  });

  it('reports blocked realtime playback instead of swallowing play rejection', async () => {
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValue(new Error('Blocked'));
    const hook = open();
    deliverStream();
    await act(async () => {});
    expect(hook.result.current.runtime).toMatchObject({ status: 'error', error: 'Playback blocked', fps: 0 });
    decoded = 1;
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(hook.result.current.runtime.status).toBe('error');
  });

  it('allows an interrupted play request to recover instead of treating it as blocked', async () => {
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new DOMException('Media reattached', 'AbortError'));
    const hook = open();
    deliverStream();
    await act(async () => {});
    expect(hook.result.current.runtime.status).toBe('connecting');
    decoded = 30;
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(hook.result.current.runtime).toMatchObject({ status: 'online', fps: 30, transport: 'webrtc' });
  });

  it('retries the realtime connection after a transport error', async () => {
    const hook = open();
    act(() => mocked.rtc[0].callbacks.onError(new Error('Connection failed')));
    expect(mocked.rtc[0].close).toHaveBeenCalledOnce();
    expect(hook.result.current.runtime.transport).toBe('webrtc');
    expect(hook.result.current.runtime.playbackWarning).toMatch(/Connection failed.*TCP 8889.*UDP\/TCP 8189/);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(mocked.rtc).toHaveLength(2);
  });
});
