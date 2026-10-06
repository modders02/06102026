import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSlot, useCameraSlots, type CameraSlot } from '@/hooks/useCameraSlots';
import { useCameraSlotConnections } from '@/hooks/useCameraSlotConnections';
import type { BackendCameraStatus, BackendStatus } from '@/lib/multiCamServer';

const mocks = vi.hoisted(() => ({
  cameras: [] as BackendCameraStatus[],
  getMultiStatus: vi.fn(), syncCameras: vi.fn(), startCamera: vi.fn(), stopCamera: vi.fn(),
}));
vi.mock('@/lib/multiCamServer', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/multiCamServer')>(),
  getMultiStatus: mocks.getMultiStatus, syncCameras: mocks.syncCameras,
  startCamera: mocks.startCamera, stopCamera: mocks.stopCamera,
}));

function Connections() {
  const { slots, updateSlot } = useCameraSlots();
  useCameraSlotConnections(slots, updateSlot);
  return <>
    <button onClick={() => updateSlot(1, { autoConnect: false, connected: false, streamUrl: '', webrtcUrl: '' })}>Disconnect</button>
    <button onClick={() => updateSlot(1, { ip: '192.168.1.20' })}>Change camera IP</button>
  </>;
}
const saved = () => JSON.parse(localStorage.getItem('msd-camera-slots-v1')!).slots as CameraSlot[];
const store = (slots: CameraSlot[]) => localStorage.setItem('msd-camera-slots-v1', JSON.stringify({ count: 1, slots }));
const status = (): BackendStatus => ({
  mediamtx: true, hls_port: 8888, lan_ip: '192.168.1.50', whisper: false, error: null,
  cameras: mocks.cameras.map(camera => ({ ...camera })),
});
const finishStart = (id: string) => {
  const camera = mocks.cameras.find(camera => camera.id === id)!;
  camera.ffmpeg = true;
  camera.hls_ready = true;
  return { success: true };
};

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  mocks.cameras = [];
  mocks.getMultiStatus.mockReset().mockImplementation(async () => status());
  mocks.syncCameras.mockReset().mockImplementation(async (_server, cameras) => {
    mocks.cameras = cameras.map((camera: { id: string; path: string; name: string; enabled: boolean }) => ({
      ...camera, ffmpeg: false, hls_ready: false, restarts: 0, error: null,
      stream: `http://192.168.1.50:8888/${camera.path}/index.m3u8`,
      stream_local: `http://127.0.0.1:8888/${camera.path}/index.m3u8`,
      webrtc_local: `http://127.0.0.1:8889/${camera.path}/whep`,
    }));
    return { success: true };
  });
  mocks.startCamera.mockReset().mockImplementation(async (_server, id) => finishStart(id));
  mocks.stopCamera.mockReset().mockResolvedValue({ success: true });
  store([{ ...makeSlot(1), ip: '192.168.1.10', connected: true, autoConnect: true }]);
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('saved camera connections', () => {
  it('restores legacy desktop cameras after reopen without a connection dialog and syncs every configured slot', async () => {
    const legacy = { ...makeSlot(1), ip: '192.168.1.10', connected: true, username: 'admin', password: 'saved password' };
    delete legacy.autoConnect;
    store([
      legacy,
      { ...makeSlot(2), ip: '192.168.1.11', connected: true, autoConnect: true },
      { ...makeSlot(3), ip: '192.168.1.12' },
    ]);
    render(<Connections />);
    await act(async () => {});

    expect(mocks.syncCameras).toHaveBeenCalledOnce();
    expect(mocks.syncCameras.mock.calls[0][1]).toEqual([
      expect.objectContaining({ id: 'slot-1', rtspUrl: 'rtsp://admin:saved%20password@192.168.1.10:554/stream1', enabled: true }),
      expect.objectContaining({ id: 'slot-2', enabled: true }),
      expect.objectContaining({ id: 'slot-3', enabled: false }),
    ]);
    expect(mocks.startCamera.mock.calls.map(([, id]) => id)).toEqual(['slot-1', 'slot-2']);
    expect(saved()[0]).toMatchObject({ autoConnect: true, connected: true,
      streamUrl: 'http://127.0.0.1:8888/cam1/index.m3u8', webrtcUrl: 'http://127.0.0.1:8889/cam1/whep' });
    expect(saved()[2].connected).toBe(false);
  });

  it('keeps restoration intent while desktop setup is still starting the bridge', async () => {
    mocks.getMultiStatus.mockRejectedValueOnce(new Error('Connection refused'));
    render(<Connections />);
    await act(async () => {});
    expect(saved()[0]).toMatchObject({ connected: false, autoConnect: true });
    expect(mocks.syncCameras).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(mocks.startCamera).toHaveBeenCalledOnce();
    expect(saved()[0].connected).toBe(true);
  });

  it('restores the registry again when the bridge restarts during an open desktop session', async () => {
    render(<Connections />);
    await act(async () => {});
    mocks.cameras = [];
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(mocks.syncCameras).toHaveBeenCalledTimes(2);
    expect(mocks.startCamera).toHaveBeenCalledTimes(2);
    expect(saved()[0]).toMatchObject({ connected: true, autoConnect: true });
  });

  it('keeps explicitly disconnected cameras stopped after reopening', async () => {
    store([{ ...makeSlot(1), ip: '192.168.1.10', autoConnect: false, connected: false }]);
    render(<Connections />);
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(mocks.syncCameras).not.toHaveBeenCalled();
    expect(mocks.startCamera).not.toHaveBeenCalled();
  });

  it('does not duplicate slow starts and honors Disconnect while restoration is in progress', async () => {
    let complete!: () => void;
    mocks.startCamera.mockImplementation((_server, id) => new Promise(resolve => {
      complete = () => resolve(finishStart(id));
    }));
    render(<Connections />);
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(12500); });
    expect(mocks.startCamera).toHaveBeenCalledOnce();
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Disconnect' })));
    await act(async () => complete());
    expect(mocks.stopCamera).toHaveBeenCalledWith('http://127.0.0.1:5000', 'slot-1');
    expect(saved()[0]).toMatchObject({ connected: false, autoConnect: false, streamUrl: '', webrtcUrl: '' });
    mocks.cameras = [];
    await act(async () => { await vi.advanceTimersByTimeAsync(12500); });
    expect(mocks.startCamera).toHaveBeenCalledOnce();
    expect(saved()[0].autoConnect).toBe(false);
  });

  it('ignores a live status request that completes after Disconnect', async () => {
    let complete!: (value: BackendStatus) => void;
    mocks.getMultiStatus.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    render(<Connections />);
    await act(async () => {});
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Disconnect' })));
    await act(async () => complete({ ...status(), cameras: [{
      id: 'slot-1', path: 'cam1', name: 'Camera 1', enabled: true, ffmpeg: true, hls_ready: true,
      stream: 'http://127.0.0.1:8888/cam1/index.m3u8', stream_local: 'http://127.0.0.1:8888/cam1/index.m3u8',
      restarts: 0, error: null,
    }] }));
    expect(saved()[0]).toMatchObject({ connected: false, autoConnect: false, streamUrl: '', webrtcUrl: '' });
    expect(mocks.startCamera).not.toHaveBeenCalled();
  });

  it('restores the current saved address if it changes while the old stream is starting', async () => {
    let complete!: () => void;
    mocks.startCamera.mockImplementationOnce((_server, id) => new Promise(resolve => {
      complete = () => resolve(finishStart(id));
    }));
    mocks.stopCamera.mockImplementation(async () => {
      mocks.cameras[0].ffmpeg = false;
      mocks.cameras[0].hls_ready = false;
      return { success: true };
    });
    render(<Connections />);
    await act(async () => {});
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Change camera IP' })));
    await act(async () => complete());
    expect(mocks.stopCamera).toHaveBeenCalledOnce();
    expect(saved()[0]).toMatchObject({ ip: '192.168.1.20', connected: false, autoConnect: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(mocks.syncCameras.mock.calls[1][1][0].rtspUrl).toBe('rtsp://192.168.1.20:554/stream1');
    expect(saved()[0].connected).toBe(true);
  });

  it('waits for readiness without restarting an existing FFmpeg process', async () => {
    mocks.cameras = [{ id: 'slot-1', path: 'cam1', name: 'Camera 1', enabled: true,
      ffmpeg: true, hls_ready: false, stream: 'http://127.0.0.1:8888/cam1/index.m3u8',
      stream_local: 'http://127.0.0.1:8888/cam1/index.m3u8', restarts: 0, error: null }];
    render(<Connections />);
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(mocks.syncCameras).not.toHaveBeenCalled();
    expect(mocks.startCamera).not.toHaveBeenCalled();
    expect(saved()[0]).toMatchObject({ connected: false, autoConnect: true });
  });

  it('paces failed restoration retries instead of restarting on every status poll', async () => {
    mocks.startCamera.mockResolvedValue({ success: false, error: 'Camera offline' });
    render(<Connections />);
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(7500); });
    expect(mocks.startCamera).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(mocks.startCamera).toHaveBeenCalledTimes(2);
    expect(saved()[0]).toMatchObject({ connected: false, autoConnect: true });
  });
});
