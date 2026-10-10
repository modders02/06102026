import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CameraMonitor from '@/components/dashboard/CameraMonitor';
import { makeSlot } from '@/hooks/useCameraSlots';
import { getCameraSession, publishCameraSession } from '@/lib/cameraSessions';
import { captureCameraEventSnapshot } from '@/lib/cameraEventSnapshot';
import { DEFAULT_SETTINGS } from '@/types/multicam';

interface MockPlayer {
  video: HTMLVideoElement | null;
  parsed: (() => void) | null;
  destroy: ReturnType<typeof vi.fn>;
}
interface MockRtc {
  callbacks: { onStream: (stream: MediaStream) => void; onError: (error: Error) => void };
  close: ReturnType<typeof vi.fn>;
}
const mocked = vi.hoisted(() => ({
  players: [] as MockPlayer[], getAudioEvents: vi.fn(), getCameraSnapshot: vi.fn(),
  analyzeFace: vi.fn(async () => {}), loadDetector: vi.fn(async () => {}), detectObjects: vi.fn(),
  computeSaliency: vi.fn(), detectFire: vi.fn(),
  openCameraWebRtc: vi.fn(), rtc: [] as MockRtc[],
  distress: { hasFace: false, expression: null as string | null, probability: 0, distressScore: 0, distressLevel: 'none' as 'none' | 'mild' | 'severe' },
  faceError: null as string | null,
}));
vi.mock('@/lib/cameraWebRtc', () => ({ openCameraWebRtc: mocked.openCameraWebRtc }));
vi.mock('hls.js', () => ({
  default: class {
    static Events = { MANIFEST_PARSED: 'parsed', ERROR: 'error' };
    static ErrorTypes = { MEDIA_ERROR: 'media' };
    static isSupported() { return true; }
    video: HTMLVideoElement | null = null;
    parsed: (() => void) | null = null;
    destroy = vi.fn();
    constructor() { mocked.players.push(this); }
    loadSource() {}
    attachMedia(video: HTMLVideoElement) { this.video = video; }
    on(event: string, callback: () => void) { if (event === 'parsed') this.parsed = callback; }
  },
}));
vi.mock('@/lib/detectionEngine', () => ({ loadDetector: mocked.loadDetector, detectObjects: mocked.detectObjects }));
vi.mock('@/lib/saliency', () => ({ computeSaliency: mocked.computeSaliency, computeSaliencyScore: () => 20 }));
vi.mock('@/lib/fireDetection', () => ({
  createFireState: () => ({}),
  detectFire: mocked.detectFire,
}));
vi.mock('@/hooks/useFaceDistress', () => {
  return { useFaceDistress: () => ({ ready: false, error: mocked.faceError, distress: mocked.distress, analyze: mocked.analyzeFace }) };
});
vi.mock('@/lib/multiCamServer', () => ({
  getAudioEvents: mocked.getAudioEvents, getCameraSnapshot: mocked.getCameraSnapshot,
  describeAudioStatus: () => ({ message: 'Listening', tone: 'ok' }),
}));
let drawImage: ReturnType<typeof vi.fn>;
let closeBitmap: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-02T00:00:00Z'));
  mocked.players.length = 0;
  mocked.rtc.length = 0;
  mocked.openCameraWebRtc.mockReset().mockImplementation((_url, callbacks: MockRtc['callbacks']) => {
    const session = { callbacks, close: vi.fn() };
    mocked.rtc.push(session);
    return session;
  });
  vi.stubGlobal('RTCPeerConnection', undefined);
  mocked.getAudioEvents.mockReset().mockResolvedValue({ events: [], status: null });
  mocked.getCameraSnapshot.mockReset().mockImplementation(async () => ({ blob: new Blob(['jpeg']), timestamp: Date.now() }));
  mocked.loadDetector.mockClear();
  mocked.detectObjects.mockReset().mockResolvedValue([]);
  mocked.analyzeFace.mockReset().mockResolvedValue(undefined);
  mocked.distress = { hasFace: false, expression: null, probability: 0, distressScore: 0, distressLevel: 'none' };
  mocked.faceError = null;
  mocked.computeSaliency.mockClear();
  mocked.detectFire.mockReset().mockReturnValue({ fireCandidate: false, fireDetected: false, smokeEmergency: false, confidence: 0, firePixelRatio: 0, smokeRatio: 0, visibility: 100 });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,preview');
  drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage,
    getImageData: () => ({ width: 320, height: 180, data: new Uint8ClampedArray(320 * 180 * 4) }),
  } as unknown as ReturnType<HTMLCanvasElement['getContext']>);
  closeBitmap = vi.fn();
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1920, height: 1080, close: closeBitmap })));
  for (const index of [1, 2, 3, 4]) {
    publishCameraSession(`slot-${index}`, { video: null, home: null, runtime: null, reconnect: null, preview: null, previewTimestamp: null, eventPreview: null });
  }
  localStorage.clear();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const helpSafetyEvent = { timestamp: '2026-10-02T00:00:01Z', transcript: 'help me', keyword: 'help', confidence: 0.99 };
const standaloneSafetyEvent = { timestamp: '2026-10-02T00:00:01Z', transcript: 'call police', keyword: 'police', confidence: 0.99 };
const screamAudioEvent = { timestamp: '2026-10-02T00:00:01Z', transcript: '', keyword: 'scream', confidence: 0.93 };
const fireAudioEvent = { timestamp: '2026-10-02T00:00:01Z', transcript: 'fire', keyword: 'fire', confidence: 0.98 };

describe('camera snapshots and page-scoped playback', () => {
  it.each([1, 2])('uses stills for camera %s on Dashboard while visual and audio triggers continue', async index => {
    mocked.detectObjects.mockResolvedValue([{ label: 'person', confidence: 0.9, bbox: [0, 0, 20, 20] }]);
    const slot = { ...makeSlot(index), ip: `192.168.1.${index}`, connected: true };
    const onEvent = vi.fn();
    render(<CameraMonitor slot={slot} monitoring playbackEnabled={false} onEvent={onEvent} />);
    await act(async () => {});
    const session = getCameraSession(`slot-${index}`);
    const firstSeenAt = session.previewTimestamp;
    expect(session.video).toBeNull();
    expect(session.home).toBeNull();
    expect(document.querySelector('video')).toBeNull();
    expect(mocked.players).toHaveLength(0);
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    expect(mocked.getCameraSnapshot).toHaveBeenCalledTimes(1);
    expect(drawImage).toHaveBeenCalledWith(expect.objectContaining({ width: 1920 }), 0, 0, 640, 360);
    expect(mocked.detectObjects).toHaveBeenCalledWith(expect.objectContaining({ width: 320, height: 180 }), expect.any(Number));
    expect(session.preview).toBe('data:image/jpeg;base64,preview');
    expect(session.runtime?.objects[0].label).toBe('person');
    expect(session.runtime?.fps).toBe(0);
    expect(session.runtime?.frameWidth).toBe(320);
    expect(session.runtime?.frameHeight).toBe(180);
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'object', cameraId: `slot-${index}` }));
    expect(closeBitmap).toHaveBeenCalledOnce();
    mocked.getAudioEvents.mockResolvedValueOnce({ events: [standaloneSafetyEvent], status: null });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      cameraId: `slot-${index}`, type: 'audio-distress', snapshot: 'data:image/jpeg;base64,preview',
    }));
    expect(getCameraSession(`slot-${index}`).runtime?.audioListening).toBe(true);
    expect(mocked.getCameraSnapshot).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1499); });
    expect(mocked.getCameraSnapshot).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(mocked.getCameraSnapshot).toHaveBeenCalledTimes(3);
    expect(getCameraSession(`slot-${index}`).previewTimestamp).toBe(firstSeenAt);
    expect(mocked.players).toHaveLength(0);
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  });

  it('shows a finished backend transcript on the next 350 ms live poll', async () => {
    vi.stubGlobal('RTCPeerConnection', class {});
    mocked.getAudioEvents
      .mockResolvedValueOnce({ events: [], status: null })
      .mockResolvedValueOnce({ events: [helpSafetyEvent], status: null });

    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    render(<CameraMonitor slot={slot} monitoring playbackEnabled />);

    await act(async () => {});
    expect(mocked.getAudioEvents).toHaveBeenCalledTimes(1);
    expect(getCameraSession('slot-1').runtime?.transcript).toBe('');

    await act(async () => { await vi.advanceTimersByTimeAsync(349); });
    expect(mocked.getAudioEvents).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(mocked.getAudioEvents).toHaveBeenCalledTimes(2);
    expect(getCameraSession('slot-1').runtime?.transcript).toBe('help me');
  });

  it('starts and removes playback on page changes without restarting audio or replaying its events', async () => {
    vi.stubGlobal('RTCPeerConnection', class {});
    const slot = { ...makeSlot(2), ip: '192.168.1.2', connected: true };
    mocked.getAudioEvents.mockResolvedValueOnce({ events: [standaloneSafetyEvent], status: null });
    const onEvent = vi.fn();
    const { rerender } = render(<CameraMonitor slot={slot} monitoring={false} playbackEnabled={false} onEvent={onEvent} />);
    await act(async () => {});
    expect(mocked.getAudioEvents).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledOnce();
    rerender(<CameraMonitor slot={slot} monitoring={false} playbackEnabled onEvent={onEvent} />);
    await act(async () => {});
    const liveSession = getCameraSession('slot-2');
    expect(liveSession.video).toBeInstanceOf(HTMLVideoElement);
    expect(mocked.openCameraWebRtc).toHaveBeenCalledOnce();
    expect(mocked.getAudioEvents).toHaveBeenCalledTimes(1);
    act(() => mocked.rtc[0].callbacks.onStream({ getTracks: () => [] } as unknown as MediaStream));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(mocked.getCameraSnapshot).toHaveBeenCalledTimes(1);
    expect(mocked.getAudioEvents).toHaveBeenLastCalledWith(expect.any(String), 'slot-2', standaloneSafetyEvent.timestamp);
    expect(onEvent).toHaveBeenCalledOnce();
    rerender(<CameraMonitor slot={slot} monitoring={false} playbackEnabled={false} onEvent={onEvent} />);
    await act(async () => {});
    expect(mocked.rtc[0].close).toHaveBeenCalledOnce();
    expect(liveSession.video?.isConnected).toBe(false);
    expect(liveSession.home?.isConnected).toBe(false);
    expect(getCameraSession('slot-2').video).toBeNull();
    expect(document.querySelector('video')).toBeNull();
    expect(mocked.getAudioEvents).toHaveBeenCalledTimes(9);
    expect(mocked.getCameraSnapshot).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenCalledOnce();
  });

  it('reuses one live player when callbacks and AI change while listening continues', async () => {
    vi.stubGlobal('RTCPeerConnection', class {});
    const slot = { ...makeSlot(2), ip: '192.168.1.2', connected: true };
    const firstHandler = vi.fn();
    const latestHandler = vi.fn();
    const { rerender, unmount } = render(<CameraMonitor slot={slot} monitoring playbackEnabled onEvent={firstHandler} />);
    await act(async () => {});
    const session = getCameraSession('slot-2');
    const visibleCard = document.createElement('div');
    document.body.appendChild(visibleCard);
    visibleCard.appendChild(session.video!);
    rerender(<CameraMonitor slot={slot} monitoring={false} playbackEnabled onEvent={latestHandler} />);
    await act(async () => {});
    expect(getCameraSession('slot-2').video).toBe(session.video);
    expect(mocked.openCameraWebRtc).toHaveBeenCalledOnce();
    expect(mocked.getAudioEvents).toHaveBeenCalledTimes(1);
    expect(mocked.getCameraSnapshot).not.toHaveBeenCalled();
    mocked.getAudioEvents.mockResolvedValueOnce({ events: [standaloneSafetyEvent], status: null });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(latestHandler).toHaveBeenCalledWith(expect.objectContaining({ cameraId: 'slot-2', type: 'audio-distress' }));
    expect(firstHandler).not.toHaveBeenCalled();
    unmount();
    expect(session.video?.isConnected).toBe(false);
    expect(session.home?.isConnected).toBe(false);
    expect(mocked.rtc[0].close).toHaveBeenCalledOnce();
    expect(getCameraSession('slot-2').video).toBeNull();
    visibleCard.remove();
  });

  it('leaves disconnected slots idle without video, network requests, or recurring updates', async () => {
    const onMetrics = vi.fn();
    render(<CameraMonitor slot={makeSlot(3)} monitoring playbackEnabled onMetrics={onMetrics} />);
    await act(async () => {});
    const initialUpdates = onMetrics.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(mocked.players).toHaveLength(0);
    expect(document.querySelector('video')).toBeNull();
    expect(mocked.getAudioEvents).not.toHaveBeenCalled();
    expect(mocked.getCameraSnapshot).not.toHaveBeenCalled();
    expect(mocked.loadDetector).not.toHaveBeenCalled();
    expect(onMetrics).toHaveBeenCalledTimes(initialUpdates);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains its last still after snapshot failure, disconnect, and unmount', async () => {
    const slot = { ...makeSlot(4), ip: '192.168.1.4', connected: true };
    const { rerender, unmount } = render(<CameraMonitor slot={slot} monitoring={false} playbackEnabled={false} />);
    await act(async () => {});
    const still = getCameraSession('slot-4').preview;
    const timestamp = getCameraSession('slot-4').previewTimestamp;
    mocked.getCameraSnapshot.mockRejectedValue(new Error('Camera snapshot unavailable'));
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(getCameraSession('slot-4').runtime?.status).toBe('error');
    expect(getCameraSession('slot-4').preview).toBe(still);
    expect(getCameraSession('slot-4').previewTimestamp).toBe(timestamp);
    expect(getCameraSession('slot-4').runtime?.audioListening).toBe(true);
    rerender(<CameraMonitor slot={{ ...slot, connected: false }} monitoring={false} playbackEnabled={false} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(mocked.getCameraSnapshot).toHaveBeenCalledTimes(2);
    expect(getCameraSession('slot-4').preview).toBe(still);
    unmount();
    expect(getCameraSession('slot-4').runtime).toBeNull();
    expect(getCameraSession('slot-4').preview).toBe(still);
  });

  it('aborts an in-flight snapshot when entering Cameras', async () => {
    vi.stubGlobal('RTCPeerConnection', class {});
    mocked.getCameraSnapshot.mockImplementation(() => new Promise(() => {}));
    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    const { rerender } = render(<CameraMonitor slot={slot} monitoring={false} playbackEnabled={false} />);
    await act(async () => {});
    const signal = mocked.getCameraSnapshot.mock.calls[0][2] as AbortSignal;
    expect(signal.aborted).toBe(false);
    rerender(<CameraMonitor slot={slot} monitoring={false} playbackEnabled />);
    await act(async () => {});
    expect(signal.aborted).toBe(true);
    expect(mocked.openCameraWebRtc).toHaveBeenCalledOnce();
  });

  it('captures local webcam stills without playback and attaches its stream only on Cameras', async () => {
    const track = { stop: vi.fn() };
    const stream = { getVideoTracks: () => [track] } as unknown as MediaStream;
    const grabFrame = vi.fn(async () => ({ width: 1920, height: 1080, close: closeBitmap }));
    vi.stubGlobal('ImageCapture', class { grabFrame = grabFrame; });
    const slot = makeSlot(1);
    const { rerender } = render(<CameraMonitor slot={slot} monitoring={false} playbackEnabled={false} localStream={stream} />);
    await act(async () => {});
    expect(grabFrame).toHaveBeenCalledOnce();
    expect(closeBitmap).toHaveBeenCalledOnce();
    expect(getCameraSession('slot-1').preview).toBe('data:image/jpeg;base64,preview');
    expect(document.querySelector('video')).toBeNull();
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    expect(mocked.getCameraSnapshot).not.toHaveBeenCalled();
    expect(mocked.getAudioEvents).not.toHaveBeenCalled();
    rerender(<CameraMonitor slot={slot} monitoring={false} playbackEnabled localStream={stream} />);
    await act(async () => {});
    expect(getCameraSession('slot-1').video?.srcObject).toBe(stream);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce();
    expect(mocked.players).toHaveLength(0);
    rerender(<CameraMonitor slot={slot} monitoring={false} playbackEnabled={false} localStream={stream} />);
    await act(async () => {});
    expect(document.querySelector('video')).toBeNull();
    expect(track.stop).not.toHaveBeenCalled();
    expect(mocked.getAudioEvents).not.toHaveBeenCalled();
  });

  it('keeps webcam previews free of video when the browser cannot capture still frames', async () => {
    vi.stubGlobal('ImageCapture', undefined);
    const stream = { getVideoTracks: () => [{ readyState: 'live' }] } as unknown as MediaStream;
    render(<CameraMonitor slot={makeSlot(1)} monitoring={false} playbackEnabled={false} localStream={stream} />);
    await act(async () => {});
    expect(getCameraSession('slot-1').runtime?.error).toContain('Still previews are unavailable');
    expect(document.querySelector('video')).toBeNull();
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    expect(mocked.getCameraSnapshot).not.toHaveBeenCalled();
    expect(mocked.getAudioEvents).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('revokes a pending fallback image URL immediately when the monitor unmounts', async () => {
    vi.stubGlobal('createImageBitmap', undefined);
    const revoke = vi.fn();
    const NativeURL = URL;
    vi.stubGlobal('URL', class extends NativeURL {
      static createObjectURL = vi.fn(() => 'blob:pending-snapshot');
      static revokeObjectURL = revoke;
    });
    // Leave decoding pending to exercise cancellation before the image loads.
    vi.stubGlobal('Image', class { onload = null; onerror = null; src = ''; });
    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    const { unmount } = render(<CameraMonitor slot={slot} monitoring={false} playbackEnabled={false} />);
    await act(async () => {});
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    expect(revoke).not.toHaveBeenCalled();
    unmount();
    await act(async () => {});
    expect(revoke).toHaveBeenCalledWith('blob:pending-snapshot');
    expect(getCameraSession('slot-1').runtime).toBeNull();
    expect(document.querySelector('video')).toBeNull();
  });

  it('uses the current AI switch when a JPEG finishes loading', async () => {
    let finishSnapshot: (result: { blob: Blob; timestamp: number }) => void;
    mocked.getCameraSnapshot.mockImplementationOnce(() => new Promise(resolve => { finishSnapshot = resolve; }));
    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    const onEvent = vi.fn();
    const { rerender } = render(<CameraMonitor slot={slot} monitoring playbackEnabled={false} onEvent={onEvent} />);
    await act(async () => {});
    rerender(<CameraMonitor slot={slot} monitoring={false} playbackEnabled={false} onEvent={onEvent} />);
    await act(async () => { finishSnapshot({ blob: new Blob(['jpeg']), timestamp: Date.now() }); });
    expect(getCameraSession('slot-1').preview).toBe('data:image/jpeg;base64,preview');
    expect(mocked.detectObjects).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
    expect(getCameraSession('slot-1').runtime?.audioListening).toBe(true);
  });

  it('drops pending visual inference when AI is disabled and keeps audio listening', async () => {
    let finishDetection: (objects: { label: string; confidence: number; bbox: number[] }[]) => void;
    mocked.detectObjects.mockImplementationOnce(() => new Promise(resolve => { finishDetection = resolve; }));
    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    const onEvent = vi.fn();
    const { rerender } = render(<CameraMonitor slot={slot} monitoring playbackEnabled={false} onEvent={onEvent} />);
    await act(async () => {});
    expect(mocked.detectObjects).toHaveBeenCalledOnce();
    rerender(<CameraMonitor slot={slot} monitoring={false} playbackEnabled={false} onEvent={onEvent} />);
    await act(async () => { finishDetection([{ label: 'person', confidence: 0.99, bbox: [0, 0, 20, 20] }]); });
    expect(onEvent).not.toHaveBeenCalled();
    expect(mocked.analyzeFace).not.toHaveBeenCalled();
    expect(getCameraSession('slot-1').runtime?.objects).toEqual([]);
    expect(getCameraSession('slot-1').runtime?.lastDetectionAt).toBeNull();
    expect(getCameraSession('slot-1').runtime?.audioListening).toBe(true);
  });

  it('keeps background analysis refreshing while the displayed last-seen image stays static', async () => {
    let finishDetection: (objects: unknown[]) => void;
    mocked.detectObjects.mockImplementationOnce(() => new Promise(resolve => { finishDetection = resolve; }));
    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    render(<CameraMonitor slot={slot} monitoring playbackEnabled={false} />);
    await act(async () => {});
    const firstSeenAt = getCameraSession('slot-1').previewTimestamp;
    expect(closeBitmap).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(mocked.getCameraSnapshot).toHaveBeenCalledTimes(2);
    expect(mocked.detectObjects).toHaveBeenCalledOnce();
    expect(closeBitmap).toHaveBeenCalledTimes(2);
    expect(getCameraSession('slot-1').previewTimestamp).toBe(firstSeenAt);
    await act(async () => { finishDetection([]); });
  });

  it('ignores facial distress from work started before AI was disabled and re-enabled', async () => {
    let finishFace: () => void;
    mocked.analyzeFace.mockImplementationOnce(() => new Promise(resolve => { finishFace = resolve; }));
    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    const onEvent = vi.fn();
    const { rerender } = render(<CameraMonitor slot={slot} monitoring playbackEnabled={false} onEvent={onEvent} />);
    await act(async () => {});
    expect(mocked.analyzeFace).toHaveBeenCalledOnce();
    rerender(<CameraMonitor slot={slot} monitoring={false} playbackEnabled={false} onEvent={onEvent} />);
    mocked.distress = { hasFace: true, expression: 'fearful', probability: 0.99, distressScore: 99, distressLevel: 'severe' };
    rerender(<CameraMonitor slot={slot} monitoring playbackEnabled={false} onEvent={onEvent} />);
    await act(async () => { finishFace(); });
    expect(onEvent).not.toHaveBeenCalled();
    expect(getCameraSession('slot-1').runtime?.faceDistress.detected).toBe(false);
  });

  it.each([
    ['happy', 'Happy', false, ''],
    ['sad', 'Sad', false, ''],
    ['angry', 'Angry', true, 'Angry'],
    ['fearful', 'Frightened', true, 'Frightened'],
    ['surprised', 'Frightened', true, 'Frightened'],
    ['neutral', 'Neutral', false, ''],
    ['disgusted', 'Disgust', false, ''],
  ] as const)('records %s as a non-alert emotion event', async (expression, label, distressDetected, distressLabel) => {
    mocked.analyzeFace.mockImplementationOnce(async () => {
      const severeCarryover = ['sad', 'neutral', 'disgusted'].includes(expression);
      mocked.distress = { hasFace: true, expression, probability: 0.94, distressScore: severeCarryover ? 94 : 0, distressLevel: severeCarryover ? 'severe' : 'none' };
    });
    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    const onEvent = vi.fn();
    render(<CameraMonitor slot={slot} monitoring playbackEnabled={false} onEvent={onEvent} />);
    await act(async () => {});

    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'emotion',
      label,
      confidence: 0.94,
      cameraId: 'slot-1',
    }));
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'face-distress' }));
    expect(getCameraSession('slot-1').runtime?.faceDistress.detected).toBe(distressDetected);
    if (distressDetected) {
      expect(getCameraSession('slot-1').runtime?.faceDistress.label).toBe(distressLabel);
    }
  });

  it.each([
    ['angry', 'help me', 'help', 'Angry'],
    ['fearful', 'help me', 'help', 'Frightened'],
    ['surprised', 'help me', 'help', 'Frightened'],
    ['shock', 'help me', 'help', 'Frightened'],
  ] as const)('verifies %s + accepted help as one multimodal alert', async (expression, transcript, keyword, faceLabel) => {
    mocked.getAudioEvents.mockResolvedValueOnce({
      events: [{ timestamp: '2026-10-02T00:00:01Z', transcript, keyword, confidence: 0.96 }],
      status: null,
    });
    mocked.analyzeFace.mockImplementationOnce(async () => {
      mocked.distress = { hasFace: true, expression, probability: 0.94, distressScore: 90, distressLevel: 'severe' };
    });
    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    const onEvent = vi.fn();
    render(<CameraMonitor slot={slot} monitoring playbackEnabled={false} onEvent={onEvent} />);
    await act(async () => {});

    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'multimodal-distress',
      label: `Verified distress: ${faceLabel} + "${keyword}"`,
      confidence: 0.94,
      snapshot: 'data:image/jpeg;base64,preview',
      alertValidation: expect.objectContaining({
        status: 'accepted',
        keyword: 'help',
        emotion: faceLabel,
      }),
    }));
    expect(getCameraSession('slot-1').runtime?.alertValidation).toMatchObject({
      status: 'accepted',
      keyword: 'help',
      emotion: faceLabel,
    });
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'face-distress' }));
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'audio-distress' }));
  });

  it('does not treat transcript-only "help" as accepted KWS evidence', async () => {
    mocked.getAudioEvents.mockResolvedValueOnce({
      events: [{
        timestamp: '2026-10-02T00:00:01Z',
        transcript: 'help me',
        keyword: 'police',
        confidence: 0.99,
      }],
      status: null,
    });
    mocked.analyzeFace.mockImplementationOnce(async () => {
      mocked.distress = {
        hasFace: true,
        expression: 'angry',
        probability: 0.95,
        distressScore: 90,
        distressLevel: 'severe',
      };
    });

    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    const onEvent = vi.fn();
    render(<CameraMonitor slot={slot} monitoring playbackEnabled={false} onEvent={onEvent} />);
    await act(async () => {});

    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'multimodal-distress',
    }));
  });

  it('uses an accepted trained "help" keyword even when transcript text is different', async () => {
    mocked.getAudioEvents.mockResolvedValueOnce({
      events: [{
        timestamp: '2026-10-02T00:00:01Z',
        transcript: 'unrelated display text',
        keyword: 'help',
        confidence: 0.96,
      }],
      status: null,
    });
    mocked.analyzeFace.mockImplementationOnce(async () => {
      mocked.distress = {
        hasFace: true,
        expression: 'angry',
        probability: 0.94,
        distressScore: 90,
        distressLevel: 'severe',
      };
    });

    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    const onEvent = vi.fn();
    render(<CameraMonitor slot={slot} monitoring playbackEnabled={false} onEvent={onEvent} />);
    await act(async () => {});

    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'multimodal-distress',
      label: 'Verified distress: Angry + "help"',
    }));
  });

  it('keeps a recent Frightened face through neutral jitter until help arrives', async () => {
    mocked.getAudioEvents
      .mockResolvedValueOnce({ events: [], status: null })
      .mockResolvedValueOnce({ events: [], status: null })
      .mockResolvedValueOnce({ events: [], status: null })
      .mockResolvedValueOnce({
        events: [{ timestamp: '2026-10-02T00:00:04Z', transcript: 'help me', keyword: 'help', confidence: 0.96 }],
        status: null,
      });

    mocked.analyzeFace
      .mockImplementationOnce(async () => {
        mocked.distress = { hasFace: true, expression: 'fearful', probability: 0.94, distressScore: 90, distressLevel: 'severe' };
      })
      .mockImplementationOnce(async () => {
        mocked.distress = { hasFace: true, expression: 'neutral', probability: 0.91, distressScore: 0, distressLevel: 'none' };
      });

    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    const onEvent = vi.fn();
    render(<CameraMonitor slot={slot} monitoring playbackEnabled={false} onEvent={onEvent} />);
    await act(async () => {});

    expect(getCameraSession('slot-1').runtime?.faceDistress).toMatchObject({
      detected: true,
      label: 'Frightened',
    });

    // A later neutral frame may hide the live face state, but the recent
    // Frightened fusion signal remains valid until its timestamp expires.
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(getCameraSession('slot-1').runtime?.faceDistress.detected).toBe(false);

    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'multimodal-distress',
      label: 'Verified distress: Frightened + "help"',
      confidence: 0.94,
      cameraId: 'slot-1',
    }));
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'face-distress' }));
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'audio-distress' }));
  });

  it('does not fall back to a facial alarm for weak Angry/Frightened candidates', async () => {
    mocked.analyzeFace.mockImplementationOnce(async () => {
      mocked.distress = { hasFace: true, expression: 'fearful', probability: 0.4, distressScore: 90, distressLevel: 'severe' };
    });
    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    const onEvent = vi.fn();
    render(<CameraMonitor slot={slot} monitoring playbackEnabled={false} onEvent={onEvent} />);
    await act(async () => {});
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'face-distress' }));
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'multimodal-distress' }));
  });

  it('does not alarm on Angry without help', async () => {
    mocked.analyzeFace.mockImplementationOnce(async () => {
      mocked.distress = { hasFace: true, expression: 'angry', probability: 0.95, distressScore: 90, distressLevel: 'severe' };
    });
    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    const onEvent = vi.fn();
    render(<CameraMonitor slot={slot} monitoring playbackEnabled={false} onEvent={onEvent} />);
    await act(async () => {});
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'face-distress' }));
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'multimodal-distress' }));
    expect(getCameraSession('slot-1').runtime?.faceDistress).toMatchObject({ detected: true, label: 'Angry' });
  });

  it('does not alarm on emergency even with Angry', async () => {
    mocked.getAudioEvents.mockResolvedValueOnce({
      events: [{ timestamp: '2026-10-02T00:00:01Z', transcript: 'emergency', keyword: 'emergency', confidence: 0.99 }],
      status: null,
    });
    mocked.analyzeFace.mockImplementationOnce(async () => {
      mocked.distress = { hasFace: true, expression: 'angry', probability: 0.95, distressScore: 90, distressLevel: 'severe' };
    });
    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    const onEvent = vi.fn();
    render(<CameraMonitor slot={slot} monitoring playbackEnabled={false} onEvent={onEvent} />);
    await act(async () => {});
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'multimodal-distress' }));
  });

  it('treats configured surprised + help as Frightened + help', async () => {
    mocked.getAudioEvents.mockResolvedValueOnce({ events: [helpSafetyEvent], status: null });
    mocked.analyzeFace.mockImplementationOnce(async () => {
      mocked.distress = { hasFace: true, expression: 'surprised', probability: 0.95, distressScore: 90, distressLevel: 'severe' };
    });
    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    const onEvent = vi.fn();
    render(<CameraMonitor slot={slot} monitoring playbackEnabled={false} onEvent={onEvent} />);
    await act(async () => {});
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'multimodal-distress',
      label: 'Verified distress: Frightened + "help"',
    }));
  });

  it('does not alarm on help without Angry or Frightened', async () => {
    mocked.getAudioEvents.mockResolvedValueOnce({ events: [helpSafetyEvent], status: null });
    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    const onEvent = vi.fn();
    render(<CameraMonitor slot={slot} monitoring playbackEnabled={false} onEvent={onEvent} />);
    await act(async () => {});
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'audio-distress' }));
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'multimodal-distress' }));
  });

  it('rejects accepted help when facial-expression detection is unavailable', async () => {
    mocked.faceError = 'Face model unavailable';
    mocked.getAudioEvents.mockResolvedValueOnce({ events: [helpSafetyEvent], status: null });
    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    const onEvent = vi.fn();
    render(<CameraMonitor slot={slot} monitoring playbackEnabled={false} onEvent={onEvent} />);
    await act(async () => {});

    expect(getCameraSession('slot-1').runtime?.alertValidation).toMatchObject({
      status: 'rejected',
      keyword: 'help',
    });
    expect(getCameraSession('slot-1').runtime?.alertValidation?.reason)
      .toMatch(/facial-expression detection failed/i);
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'multimodal-distress' }));
  });

  it('moves accepted help from PENDING to REJECTED when facial evidence never arrives', async () => {
    mocked.getAudioEvents.mockResolvedValueOnce({ events: [helpSafetyEvent], status: null });
    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    const onEvent = vi.fn();
    render(<CameraMonitor slot={slot} monitoring playbackEnabled={false} onEvent={onEvent} />);
    await act(async () => {});

    expect(getCameraSession('slot-1').runtime?.alertValidation).toMatchObject({
      status: 'pending',
      keyword: 'help',
    });
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'multimodal-distress' }));

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(getCameraSession('slot-1').runtime?.alertValidation).toMatchObject({
      status: 'rejected',
      keyword: 'help',
    });
    expect(getCameraSession('slot-1').runtime?.alertValidation?.reason)
      .toMatch(/no Angry\/Frightened face/i);
  });

  it('shows a rejected KWS candidate reason without creating an alert event', async () => {
    mocked.getAudioEvents.mockResolvedValueOnce({
      events: [],
      status: {
        thread_running: true,
        connected: true,
        chunks_received: 1,
        bytes_received: 32000,
        last_chunk_at: '2026-10-02T00:00:01Z',
        last_transcription_at: null,
        last_transcript: '',
        error: null,
        ffmpeg_error: null,
        custom_kws: {
          last_segment_at: '2026-10-02T00:00:01Z',
          last_candidate: 'help',
          last_candidate_confidence: 0.61,
          last_decision: 'below_threshold',
        },
      },
    });
    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    const onEvent = vi.fn();
    render(<CameraMonitor slot={slot} monitoring playbackEnabled={false} onEvent={onEvent} />);
    await act(async () => {});

    expect(getCameraSession('slot-1').runtime?.alertValidation).toMatchObject({
      status: 'rejected',
      keyword: 'help',
      sourceDecision: 'below_threshold',
    });
    expect(getCameraSession('slot-1').runtime?.alertValidation?.reason)
      .toMatch(/below the trained acceptance threshold/i);
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'multimodal-distress' }));
  });

  it('allows consecutive valid help triggers without duplicating one trigger', async () => {
    const firstHelp = {
      timestamp: '2026-10-02T00:00:01Z',
      transcript: 'help',
      keyword: 'help',
      confidence: 0.96,
    };
    const secondHelp = {
      timestamp: '2026-10-02T00:00:02Z',
      transcript: 'help',
      keyword: 'help',
      confidence: 0.97,
    };
    mocked.getAudioEvents
      .mockResolvedValueOnce({ events: [firstHelp], status: null })
      .mockResolvedValueOnce({ events: [], status: null })
      .mockResolvedValueOnce({ events: [secondHelp], status: null });
    mocked.analyzeFace.mockImplementation(async () => {
      mocked.distress = {
        hasFace: true,
        expression: 'angry',
        probability: 0.95,
        distressScore: 90,
        distressLevel: 'severe',
      };
    });

    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    const onEvent = vi.fn();
    render(<CameraMonitor slot={slot} monitoring playbackEnabled={false} onEvent={onEvent} />);
    await act(async () => {});

    const distressCalls = () => onEvent.mock.calls
      .map(([event]) => event)
      .filter(event => event.type === 'multimodal-distress');
    expect(distressCalls()).toHaveLength(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(distressCalls()).toHaveLength(2);
    expect(distressCalls()[0].label).toBe('Verified distress: Angry + "help"');
    expect(distressCalls()[1].label).toBe('Verified distress: Angry + "help"');
  });

  it('does not alarm on fire without a visual fire candidate', async () => {
    mocked.getAudioEvents.mockResolvedValueOnce({ events: [fireAudioEvent], status: null });
    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    const onEvent = vi.fn();
    render(<CameraMonitor slot={slot} monitoring playbackEnabled={false} onEvent={onEvent} />);
    await act(async () => {});
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'audio-distress' }));
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'fire' }));
  });

  it('verifies a small visual fire candidate plus fire on a current visual frame', async () => {
    mocked.getAudioEvents.mockResolvedValueOnce({ events: [fireAudioEvent], status: null });
    mocked.detectFire.mockReturnValue({
      fireCandidate: true,
      fireDetected: false,
      smokeEmergency: false,
      confidence: 0.2,
      firePixelRatio: 0.001,
      smokeRatio: 0.02,
      visibility: 88,
    });
    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    const onEvent = vi.fn();
    render(<CameraMonitor slot={slot} monitoring playbackEnabled={false} onEvent={onEvent} />);
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'fire',
      label: 'Verified fire: visual fire + "fire"',
      cameraId: 'slot-1',
      snapshot: 'data:image/jpeg;base64,preview',
    }));
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'audio-distress' }));
  });

  it('does not let a stale fire candidate plus fire verify fire once a device screen is recognized', async () => {
    mocked.getAudioEvents
      .mockResolvedValueOnce({ events: [], status: null })
      .mockResolvedValueOnce({ events: [fireAudioEvent], status: null });
    mocked.detectFire
      .mockReturnValueOnce({
        fireCandidate: true,
        fireDetected: false,
        smokeEmergency: false,
        screenSuppressed: false,
        confidence: 0.3,
        firePixelRatio: 0.01,
        smokeRatio: 0.02,
        visibility: 85,
      })
      .mockReturnValueOnce({
        fireCandidate: false,
        fireDetected: false,
        smokeEmergency: false,
        screenSuppressed: true,
        confidence: 0,
        firePixelRatio: 0.01,
        smokeRatio: 0.2,
        visibility: 60,
        rejectedReason: 'displayed fire inside tv — ignored',
      });

    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    const onEvent = vi.fn();
    render(<CameraMonitor slot={slot} monitoring playbackEnabled={false} onEvent={onEvent} />);
    await act(async () => {});

    // Speech arrives after the old visual candidate. It must wait for a current
    // visual frame instead of verifying from stale state.
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'fire' }));

    // The next visual frame identifies the flames as TV content and clears
    // both pending fusion signals.
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'fire' }));
    expect(getCameraSession('slot-1').runtime?.fire).toMatchObject({
      detected: false,
      candidate: false,
      confidence: 0,
    });
    expect(getCameraSession('slot-1').runtime?.smoke.detected).toBe(false);
  });

  it('immediately alerts when a visual fire candidate overlaps a smoke region', async () => {
    mocked.detectFire.mockReturnValueOnce({
      fireCandidate: true,
      fireDetected: false,
      smokeEmergency: false,
      confidence: 0.3,
      firePixelRatio: 0.002,
      smokeRatio: 0.24,
      visibility: 70,
      smokeCorroborated: true,
      lowVisibilityCorroborated: false,
    });
    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    const onEvent = vi.fn();
    render(<CameraMonitor slot={slot} monitoring playbackEnabled={false} onEvent={onEvent} />);
    await act(async () => {});
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'fire',
      label: 'Verified fire: fire + smoke region (24%)',
      cameraId: 'slot-1',
    }));
  });

  it('immediately alerts on visual fire plus low visibility', async () => {
    mocked.detectFire.mockReturnValueOnce({
      fireCandidate: true,
      fireDetected: false,
      smokeEmergency: false,
      confidence: 0.32,
      firePixelRatio: 0.002,
      smokeRatio: 0.08,
      visibility: 40,
      smokeCorroborated: false,
      lowVisibilityCorroborated: true,
    });
    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    const onEvent = vi.fn();
    render(<CameraMonitor slot={slot} monitoring playbackEnabled={false} onEvent={onEvent} />);
    await act(async () => {});
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'fire',
      label: 'Verified fire: fire + low visibility (40/100)',
      cameraId: 'slot-1',
    }));
  });

  it('does not verify a fire-colored patch plus static gray background as fire', async () => {
    mocked.detectFire.mockReturnValueOnce({
      fireCandidate: true,
      fireDetected: false,
      smokeEmergency: false,
      screenSuppressed: false,
      confidence: 0.44,
      firePixelRatio: 0.01,
      smokeRatio: 0.60,
      visibility: 70,
      smokeCorroborated: false,
      lowVisibilityCorroborated: false,
    });
    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    const onEvent = vi.fn();
    render(<CameraMonitor slot={slot} monitoring playbackEnabled={false} onEvent={onEvent} />);
    await act(async () => {});
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'fire' }));
    expect(getCameraSession('slot-1').runtime?.fire.detected).toBe(false);
  });

  it('does not alarm on smoke region alone without a visual fire candidate', async () => {
    mocked.detectFire.mockReturnValueOnce({
      fireCandidate: false,
      fireDetected: false,
      smokeEmergency: true,
      confidence: 0.7,
      firePixelRatio: 0,
      smokeRatio: 0.3,
      visibility: 35,
    });
    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    const onEvent = vi.fn();
    render(<CameraMonitor slot={slot} monitoring playbackEnabled={false} onEvent={onEvent} />);
    await act(async () => {});
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'fire' }));
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'smoke' }));
  });

  it.each([
    'angry',
    'fearful',
    'surprised',
  ] as const)('does not use screaming + %s as a multimodal alert', async expression => {
    mocked.getAudioEvents.mockResolvedValueOnce({ events: [screamAudioEvent], status: null });
    mocked.analyzeFace.mockImplementationOnce(async () => {
      mocked.distress = { hasFace: true, expression, probability: 0.94, distressScore: 90, distressLevel: 'severe' };
    });
    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    const onEvent = vi.fn();
    render(<CameraMonitor slot={slot} monitoring playbackEnabled={false} onEvent={onEvent} />);
    await act(async () => {});

    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'multimodal-distress' }));
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'face-distress' }));
  });

  it('does not alert on Sad + screaming', async () => {
    mocked.getAudioEvents.mockResolvedValueOnce({ events: [screamAudioEvent], status: null });
    mocked.analyzeFace.mockImplementationOnce(async () => {
      mocked.distress = { hasFace: true, expression: 'sad', probability: 0.94, distressScore: 90, distressLevel: 'severe' };
    });
    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    const onEvent = vi.fn();
    render(<CameraMonitor slot={slot} monitoring playbackEnabled={false} onEvent={onEvent} />);
    await act(async () => {});

    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'emotion',
      label: 'Sad',
      confidence: 0.94,
    }));
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'multimodal-distress' }));
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'audio-distress' }));
  });

  it('does not alarm on screaming without Angry or Frightened', async () => {
    mocked.getAudioEvents.mockResolvedValueOnce({ events: [screamAudioEvent], status: null });
    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    const onEvent = vi.fn();
    render(<CameraMonitor slot={slot} monitoring playbackEnabled={false} onEvent={onEvent} />);
    await act(async () => {});
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'audio-distress' }));
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'multimodal-distress' }));
  });

  it.each(['neutral', 'disgusted'] as const)('never promotes severe %s carryover to a facial alarm', async expression => {
    mocked.analyzeFace.mockImplementationOnce(async () => {
      mocked.distress = { hasFace: true, expression, probability: 0.95, distressScore: 95, distressLevel: 'severe' };
    });
    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    const onEvent = vi.fn();
    render(<CameraMonitor slot={slot} monitoring playbackEnabled={false} onEvent={onEvent} />);
    await act(async () => {});
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'face-distress' }));
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'multimodal-distress' }));
  });

  it('preserves actual analysis dimensions for small source images', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 160, height: 90, close: closeBitmap })));
    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    render(<CameraMonitor slot={slot} monitoring playbackEnabled={false} />);
    await act(async () => {});
    expect(getCameraSession('slot-1').runtime?.frameWidth).toBe(160);
    expect(getCameraSession('slot-1').runtime?.frameHeight).toBe(90);
  });

  it('applies saliency and history preferences while retaining every object for fire filtering', async () => {
    const objects = [
      { label: 'tv', confidence: 0.99, bbox: [0, 0, 20, 20] },
      { label: 'refrigerator', confidence: 0.8, bbox: [20, 20, 20, 20] },
      { label: 'person', confidence: 0.7, bbox: [40, 20, 20, 20] },
    ];
    mocked.detectObjects.mockResolvedValue(objects);
    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    const onEvent = vi.fn();
    render(<CameraMonitor slot={slot} monitoring playbackEnabled={false} onEvent={onEvent}
      baseSettings={{ ...DEFAULT_SETTINGS, saliencyThreshold: 72, priorityObjects: ['refrigerator'] }} />);
    await act(async () => {});
    expect(mocked.computeSaliency).toHaveBeenCalledWith(expect.anything(), null, 'sobel', 72);
    expect(mocked.detectFire).toHaveBeenCalledWith(expect.anything(), expect.anything(), objects);
    expect(getCameraSession('slot-1').runtime?.objects).toEqual(objects);
    const historyLabels = onEvent.mock.calls.map(([event]) => event).filter(event => event.type === 'object').map(event => event.label);
    expect(historyLabels).toEqual(['refrigerator', 'person']);
  });

  it('keeps the displayed image and storage unchanged as background frames arrive, then saves the last real still on disconnect', async () => {
    const encode = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL');
    encode.mockReturnValueOnce('data:image/jpeg;base64,first').mockReturnValue('data:image/jpeg;base64,last');
    const write = vi.spyOn(Storage.prototype, 'setItem');
    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    const sampleEventFrame = vi.fn(() => captureCameraEventSnapshot('slot-1'));
    const { rerender } = render(<CameraMonitor slot={slot} monitoring playbackEnabled={false} onMetrics={sampleEventFrame} />);
    await act(async () => {});
    const firstSeenAt = getCameraSession('slot-1').previewTimestamp;
    expect(getCameraSession('slot-1').preview).toBe('data:image/jpeg;base64,first');
    expect(getCameraSession('slot-1').eventPreview).toBe('data:image/jpeg;base64,first');
    expect(write).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(mocked.getCameraSnapshot).toHaveBeenCalledTimes(4);
    expect(getCameraSession('slot-1').preview).toBe('data:image/jpeg;base64,first');
    expect(getCameraSession('slot-1').previewTimestamp).toBe(firstSeenAt);
    expect(getCameraSession('slot-1').eventPreview).toBe('data:image/jpeg;base64,last');
    expect(captureCameraEventSnapshot('slot-1')).toBe('data:image/jpeg;base64,last');
    expect(sampleEventFrame.mock.results.at(-1)?.value).toBe('data:image/jpeg;base64,last');
    expect(write).toHaveBeenCalledOnce();

    rerender(<CameraMonitor slot={{ ...slot, connected: false }} monitoring playbackEnabled={false} />);
    await act(async () => {});
    expect(getCameraSession('slot-1').preview).toBe('data:image/jpeg;base64,last');
    expect(getCameraSession('slot-1').previewTimestamp).toBe(Date.now());
    expect(getCameraSession('slot-1').eventPreview).toBeNull();
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('preserves a saved image when the camera reconnects and gets newer background frames', async () => {
    publishCameraSession('slot-1', { preview: 'data:image/jpeg;base64,cached', previewTimestamp: Date.now() - 60_000 });
    const write = vi.spyOn(Storage.prototype, 'setItem');
    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    render(<CameraMonitor slot={slot} monitoring playbackEnabled={false} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(getCameraSession('slot-1').preview).toBe('data:image/jpeg;base64,cached');
    expect(getCameraSession('slot-1').previewTimestamp).toBe(Date.now() - 66_000);
    expect(write).not.toHaveBeenCalled();
  });

  it.each(['leave', 'disconnect', 'unmount'])('captures the final ready video frame before teardown on %s', async boundary => {
    const slot = { ...makeSlot(2), ip: '192.168.1.2', connected: true };
    const { rerender, unmount } = render(<CameraMonitor slot={slot} monitoring={false} playbackEnabled />);
    await act(async () => {});
    const video = getCameraSession('slot-2').video!;
    Object.defineProperties(video, {
      readyState: { value: 2, configurable: true },
      videoWidth: { value: 1920, configurable: true },
      videoHeight: { value: 1080, configurable: true },
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValueOnce('data:image/jpeg;base64,final').mockReturnValue('data:image/jpeg;base64,background');
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(function (this: HTMLMediaElement) {
      if (this === video) {
        expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 640, 360);
        Object.defineProperty(video, 'readyState', { value: 0, configurable: true });
      }
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(getCameraSession('slot-2').preview).toBeNull();
    if (boundary === 'leave') rerender(<CameraMonitor slot={slot} monitoring={false} playbackEnabled={false} />);
    else if (boundary === 'disconnect') rerender(<CameraMonitor slot={{ ...slot, connected: false }} monitoring={false} playbackEnabled />);
    else unmount();
    await act(async () => {});
    expect(getCameraSession('slot-2').preview).toBe('data:image/jpeg;base64,final');
    expect(getCameraSession('slot-2').previewTimestamp).toBe(Date.now());
    expect(getCameraSession('slot-2').video).toBeNull();
    const saved = JSON.parse(localStorage.getItem('msds-camera-last-seen-v1')!);
    expect(saved['slot-2']).toEqual({ preview: 'data:image/jpeg;base64,final', previewTimestamp: Date.now() });
  });

  it('opens realtime playback only on Cameras and attaches its audio and video without HLS', async () => {
    vi.stubGlobal('RTCPeerConnection', class {});
    vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    const { rerender } = render(<CameraMonitor slot={slot} monitoring={false} playbackEnabled={false} />);
    await act(async () => {});
    expect(mocked.openCameraWebRtc).not.toHaveBeenCalled();
    expect(document.querySelector('video')).toBeNull();
    rerender(<CameraMonitor slot={slot} monitoring={false} playbackEnabled />);
    await act(async () => {});
    expect(mocked.openCameraWebRtc).toHaveBeenCalledWith(expect.stringMatching(/\/cam1\/whep$/), expect.any(Object));
    expect(mocked.players).toHaveLength(0);
    const audioTrack = { kind: 'audio', id: 'audio-1' };
    const videoTrack = { kind: 'video', id: 'video-1' };
    const stream = {
      getTracks: () => [audioTrack, videoTrack],
      getAudioTracks: () => [audioTrack], getVideoTracks: () => [videoTrack],
    } as unknown as MediaStream;
    const video = getCameraSession('slot-1').video!;
    act(() => mocked.rtc[0].callbacks.onStream(stream));
    expect(video.srcObject).toBe(stream);
    expect((video.srcObject as MediaStream).getAudioTracks()).toEqual([audioTrack]);
    expect((video.srcObject as MediaStream).getVideoTracks()).toEqual([videoTrack]);
    expect(getCameraSession('slot-1').runtime?.status).toBe('connecting');
    expect(getCameraSession('slot-1').runtime?.transport).toBe('webrtc');
    const playbackStartedAt = Date.now();
    Object.defineProperties(video, {
      readyState: { value: 2, configurable: true }, videoWidth: { value: 640 }, videoHeight: { value: 480 },
      // A live track continues decoding after its first loadeddata event.
      // Keep the stream healthy beyond the stalled-video fallback deadline.
      getVideoPlaybackQuality: { value: () => ({
        totalVideoFrames: Math.floor((Date.now() - playbackStartedAt) * 30 / 1000),
        droppedVideoFrames: 0,
      }) },
    });
    act(() => video.dispatchEvent(new Event('loadeddata')));
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(getCameraSession('slot-1').runtime?.status).toBe('online');
    expect(getCameraSession('slot-1').runtime?.fps).toBe(30);
    expect(getCameraSession('slot-1').runtime?.playbackWarning).toBeNull();
    expect(mocked.players).toHaveLength(0);
    expect(mocked.openCameraWebRtc).toHaveBeenCalledOnce();
  });

  it('retries realtime playback when its connection fails instead of falling back to HLS', async () => {
    vi.stubGlobal('RTCPeerConnection', class {});
    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    render(<CameraMonitor slot={slot} monitoring={false} playbackEnabled />);
    await act(async () => {});
    act(() => mocked.rtc[0].callbacks.onError(new Error('ICE connection failed')));
    expect(mocked.rtc[0].close).toHaveBeenCalledOnce();
    expect(mocked.players).toHaveLength(0);
    expect(getCameraSession('slot-1').runtime?.transport).toBe('webrtc');
    expect(getCameraSession('slot-1').runtime?.playbackWarning).toMatch(/ICE connection failed.*TCP 8889.*UDP\/TCP 8189/);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(mocked.openCameraWebRtc).toHaveBeenCalledTimes(2);
    expect(mocked.players).toHaveLength(0);
    expect(getCameraSession('slot-1').runtime?.status).toBe('connecting');
    const video = getCameraSession('slot-1').video!;
    act(() => mocked.rtc[1].callbacks.onStream({ getTracks: () => [] } as unknown as MediaStream));
    Object.defineProperties(video, {
      readyState: { value: 2, configurable: true }, videoWidth: { value: 640 }, videoHeight: { value: 480 },
    });
    act(() => video.dispatchEvent(new Event('loadeddata')));
    expect(getCameraSession('slot-1').runtime?.status).toBe('online');
    expect(getCameraSession('slot-1').runtime?.playbackWarning).toBeNull();
  });

  it('retries realtime playback when no frame arrives instead of switching to HLS', async () => {
    vi.stubGlobal('RTCPeerConnection', class {});
    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    render(<CameraMonitor slot={slot} monitoring={false} playbackEnabled />);
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(mocked.openCameraWebRtc).toHaveBeenCalledTimes(2);
    expect(mocked.rtc[0].close).toHaveBeenCalledOnce();
    expect(mocked.players).toHaveLength(0);
    expect(getCameraSession('slot-1').runtime?.transport).toBe('webrtc');
    expect(getCameraSession('slot-1').runtime?.playbackWarning).toMatch(/did not start/);
  });

  it('reports unsupported realtime playback without opening a compatibility stream', async () => {
    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    render(<CameraMonitor slot={slot} monitoring={false} playbackEnabled />);
    await act(async () => {});
    expect(getCameraSession('slot-1').runtime?.status).toBe('error');
    expect(getCameraSession('slot-1').runtime?.error).toMatch(/Realtime playback is not supported/);
    expect(mocked.openCameraWebRtc).not.toHaveBeenCalled();
    expect(mocked.players).toHaveLength(0);
  });

  it('closes realtime playback on leaving Cameras while preserving the last frame and backend audio cursor', async () => {
    vi.stubGlobal('RTCPeerConnection', class {});
    mocked.getAudioEvents.mockResolvedValueOnce({ events: [standaloneSafetyEvent], status: null });
    const slot = { ...makeSlot(1), ip: '192.168.1.1', connected: true };
    const onEvent = vi.fn();
    const { rerender } = render(<CameraMonitor slot={slot} monitoring={false} playbackEnabled={false} onEvent={onEvent} />);
    await act(async () => {});
    rerender(<CameraMonitor slot={slot} monitoring={false} playbackEnabled onEvent={onEvent} />);
    await act(async () => {});
    const video = getCameraSession('slot-1').video!;
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    act(() => mocked.rtc[0].callbacks.onStream(stream));
    Object.defineProperties(video, {
      readyState: { value: 2, configurable: true }, videoWidth: { value: 640 }, videoHeight: { value: 480 },
    });
    act(() => video.dispatchEvent(new Event('loadeddata')));
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(mocked.getAudioEvents).toHaveBeenCalledTimes(5);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValueOnce('data:image/jpeg;base64,final').mockReturnValue('data:image/jpeg;base64,background');
    rerender(<CameraMonitor slot={slot} monitoring={false} playbackEnabled={false} onEvent={onEvent} />);
    await act(async () => {});
    expect(mocked.rtc[0].close).toHaveBeenCalledOnce();
    expect(getCameraSession('slot-1').video).toBeNull();
    expect(getCameraSession('slot-1').preview).toBe('data:image/jpeg;base64,final');
    expect(getCameraSession('slot-1').previewTimestamp).toBe(Date.now());
    expect(getCameraSession('slot-1').runtime?.audioListening).toBe(true);
    const playCount = vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length;
    act(() => {
      mocked.rtc[0].callbacks.onStream(stream);
      mocked.rtc[0].callbacks.onError(new Error('Late callback'));
    });
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(playCount);
    expect(mocked.players).toHaveLength(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(mocked.getAudioEvents).toHaveBeenCalledTimes(6);
    expect(mocked.getAudioEvents).toHaveBeenLastCalledWith(expect.any(String), 'slot-1', standaloneSafetyEvent.timestamp);
    expect(onEvent).toHaveBeenCalledOnce();
    expect(mocked.openCameraWebRtc).toHaveBeenCalledOnce();
  });
});
