import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MultiCameraConnect from '@/components/dashboard/MultiCameraConnect';
import { makeSlot, saveServerHost } from '@/hooks/useCameraSlots';
import { clearCameraSession, publishCameraSession } from '@/lib/cameraSessions';
import type { BackendStatus } from '@/lib/multiCamServer';

const mocks = vi.hoisted(() => ({
  ready: false, lanHost: '127.0.0.1', webrtcUrl: '', webrtcLanUrl: '',
  getMultiStatus: vi.fn(), startCamera: vi.fn(), stopCamera: vi.fn(), syncCameras: vi.fn(), testCamera: vi.fn(),
}));

vi.mock('@/lib/multiCamServer', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/multiCamServer')>();
  return { ...actual, getMultiStatus: mocks.getMultiStatus, startCamera: mocks.startCamera, stopCamera: mocks.stopCamera, syncCameras: mocks.syncCameras, testCamera: mocks.testCamera };
});
vi.mock('@/components/dashboard/PrefetchModelsButton', () => ({ default: () => null }));

beforeEach(() => {
  vi.useFakeTimers();
  mocks.ready = false;
  mocks.lanHost = '127.0.0.1';
  mocks.webrtcUrl = '';
  mocks.webrtcLanUrl = '';
  localStorage.removeItem('msd-slot-server-host');
  mocks.testCamera.mockReset().mockResolvedValue({ success: true });
  mocks.syncCameras.mockReset().mockResolvedValue({ success: true });
  mocks.stopCamera.mockReset().mockImplementation(async () => {
    mocks.ready = false;
    return { success: true };
  });
  mocks.startCamera.mockReset().mockImplementation(async () => {
    mocks.ready = true;
    return { success: true, stream: 'http://127.0.0.1:8888/cam1/index.m3u8' };
  });
  mocks.getMultiStatus.mockReset().mockImplementation(async (): Promise<BackendStatus> => ({
    mediamtx: true, hls_port: 8888, lan_ip: mocks.lanHost, whisper: true, error: null,
    cameras: [{
      id: 'slot-1', path: 'cam1', name: 'Camera 1', enabled: true,
      ffmpeg: mocks.ready, hls_ready: mocks.ready,
      stream: `http://${mocks.lanHost}:8888/cam1/index.m3u8`,
      stream_local: 'http://127.0.0.1:8888/cam1/index.m3u8', restarts: 0, error: null,
      webrtc_local: mocks.webrtcUrl,
      webrtc: mocks.webrtcLanUrl,
    }],
  }));
  localStorage.setItem('msd-camera-slots-v1', JSON.stringify({
    count: 1,
    slots: [{ ...makeSlot(1), ip: '192.168.1.10' }],
  }));
  publishCameraSession('slot-1', { preview: 'data:image/jpeg;base64,snapshot', previewTimestamp: Date.now() });
});

afterEach(() => {
  cleanup();
  clearCameraSession('slot-1');
  localStorage.removeItem('msd-camera-slots-v1');
  localStorage.removeItem('msd-slot-server-host');
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('camera connection status', () => {
  const rememberConnection = () => localStorage.setItem('msd-camera-slots-v1', JSON.stringify({
    count: 1, slots: [{ ...makeSlot(1), ip: '192.168.1.10', autoConnect: true }],
  }));
  it('saves network playback endpoints for a bridge on another device', async () => {
    rememberConnection();
    mocks.ready = true;
    mocks.lanHost = '192.168.1.50';
    mocks.webrtcUrl = 'http://127.0.0.1:8889/cam1/whep';
    mocks.webrtcLanUrl = 'http://192.168.1.50:8889/cam1/whep';
    saveServerHost(mocks.lanHost);
    render(<MultiCameraConnect />);
    await act(async () => {});

    expect(mocks.getMultiStatus).toHaveBeenCalledWith('http://192.168.1.50:5000');
    const savedSlot = JSON.parse(localStorage.getItem('msd-camera-slots-v1')!).slots[0];
    expect(savedSlot.connected).toBe(true);
    expect(savedSlot.streamUrl).toBe('http://192.168.1.50:8888/cam1/index.m3u8');
    expect(savedSlot.webrtcUrl).toBe(mocks.webrtcLanUrl);
  });

  it('keeps loopback playback endpoints when the bridge runs on the installed app device', async () => {
    rememberConnection();
    mocks.ready = true;
    mocks.lanHost = '192.168.1.50';
    mocks.webrtcUrl = 'http://127.0.0.1:8889/cam1/whep';
    mocks.webrtcLanUrl = 'http://192.168.1.50:8889/cam1/whep';
    render(<MultiCameraConnect />);
    await act(async () => {});

    const savedSlot = JSON.parse(localStorage.getItem('msd-camera-slots-v1')!).slots[0];
    expect(savedSlot.streamUrl).toBe('http://127.0.0.1:8888/cam1/index.m3u8');
    expect(savedSlot.webrtcUrl).toBe(mocks.webrtcUrl);
  });

  it('keeps refreshing readiness during parent renders without displaying images or video', async () => {
    rememberConnection();
    const createElement = vi.spyOn(document, 'createElement');
    const view = render(<MultiCameraConnect />);
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeDisabled();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(mocks.getMultiStatus).toHaveBeenCalledTimes(2);

    // Dashboard metrics rerender the parent faster than the 2.5-second camera poll.
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    view.rerender(<MultiCameraConnect />);
    await act(async () => {});
    expect(mocks.getMultiStatus).toHaveBeenCalledTimes(2);
    mocks.ready = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeEnabled();
    expect(mocks.getMultiStatus).toHaveBeenCalledTimes(3);

    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    view.rerender(<MultiCameraConnect />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    view.rerender(<MultiCameraConnect />);
    mocks.ready = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeDisabled();
    expect(mocks.getMultiStatus).toHaveBeenCalledTimes(5);
    expect(view.container.querySelector('video')).toBeNull();
    expect(view.container.querySelector('img')).toBeNull();
    expect(createElement.mock.calls.some(([tag]) => tag === 'video')).toBe(false);
  });

  it('confirms a successful connection with a simple message and no preview', async () => {
    const view = render(<MultiCameraConnect />);
    await act(async () => {});
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect' })); });

    expect(mocks.testCamera).toHaveBeenCalledOnce();
    expect(mocks.startCamera).toHaveBeenCalledWith('http://127.0.0.1:5000', 'slot-1');
    expect(screen.getByRole('status')).toHaveTextContent('Camera 1 connected successfully.');
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeEnabled();
    expect(screen.queryByText(/MediaMTX|FFmpeg|HLS/)).not.toBeInTheDocument();
    expect(view.container.querySelector('img, video')).toBeNull();
    expect(JSON.parse(localStorage.getItem('msd-camera-slots-v1')!).slots[0].connected).toBe(true);
    expect(JSON.parse(localStorage.getItem('msd-camera-slots-v1')!).slots[0].autoConnect).toBe(true);
  });

  it('clears saved restoration intent when the user disconnects a camera', async () => {
    mocks.ready = true;
    localStorage.setItem('msd-camera-slots-v1', JSON.stringify({ count: 1, slots: [{
      ...makeSlot(1), ip: '192.168.1.10', connected: true, autoConnect: true,
    }] }));
    render(<MultiCameraConnect />);
    await act(async () => {});
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Disconnect' })); });
    expect(mocks.stopCamera).toHaveBeenCalledWith('http://127.0.0.1:5000', 'slot-1');
    expect(JSON.parse(localStorage.getItem('msd-camera-slots-v1')!).slots[0]).toMatchObject({ connected: false, autoConnect: false });
  });

  it('ignores a status poll that reports the old live stream after Disconnect finishes', async () => {
    rememberConnection();
    mocks.ready = true;
    render(<MultiCameraConnect />);
    await act(async () => {});
    const oldLiveStatus = await mocks.getMultiStatus();
    let complete!: (value: BackendStatus) => void;
    mocks.getMultiStatus.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Disconnect' })); });
    await act(async () => complete(oldLiveStatus));
    expect(JSON.parse(localStorage.getItem('msd-camera-slots-v1')!).slots[0]).toMatchObject({ connected: false, autoConnect: false, streamUrl: '', webrtcUrl: '' });
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeDisabled();
  });

  it('does not claim success when the camera service cannot start the camera', async () => {
    mocks.startCamera.mockResolvedValue({ success: false, error: 'Camera credentials were rejected.' });
    render(<MultiCameraConnect />);
    await act(async () => {});
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect' })); });

    expect(screen.getByText('Camera credentials were rejected.')).toBeInTheDocument();
    expect(screen.queryByText(/connected successfully/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeDisabled();
    expect(JSON.parse(localStorage.getItem('msd-camera-slots-v1')!).slots[0].connected).toBe(false);
  });

  it('waits for confirmed readiness before showing success even when start returns a stream URL', async () => {
    mocks.startCamera.mockResolvedValue({ success: true, stream: 'http://127.0.0.1:8888/cam1/index.m3u8' });
    render(<MultiCameraConnect />);
    await act(async () => {});
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect' })); });

    expect(screen.getByRole('status')).toHaveTextContent('Waiting for camera connection confirmation.');
    expect(screen.queryByText(/connected successfully/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeDisabled();
    expect(JSON.parse(localStorage.getItem('msd-camera-slots-v1')!).slots[0].connected).toBe(false);

    mocks.ready = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(screen.getByRole('status')).toHaveTextContent('Camera 1 connected successfully.');
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeEnabled();
  });

  it('adds WebRTC metadata to an already confirmed connection when it becomes available', async () => {
    rememberConnection();
    mocks.ready = true;
    render(<MultiCameraConnect />);
    await act(async () => {});
    expect(screen.getByRole('status')).toHaveTextContent('Camera 1 connected successfully.');

    mocks.webrtcUrl = 'http://127.0.0.1:8889/cam1/whep';
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    const savedSlot = JSON.parse(localStorage.getItem('msd-camera-slots-v1')!).slots[0];
    expect(savedSlot.connected).toBe(true);
    expect(savedSlot.webrtcUrl).toBe(mocks.webrtcUrl);
  });

  it('reconnects only the selected slot and preserves other disconnected cameras', async () => {
    mocks.ready = true;
    localStorage.setItem('msd-camera-slots-v1', JSON.stringify({
      count: 2,
      slots: [
        { ...makeSlot(1), ip: '192.168.1.10', connected: true, autoConnect: true },
        { ...makeSlot(2), ip: '192.168.1.11', connected: false, autoConnect: false },
      ],
    }));

    render(<MultiCameraConnect />);
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    });

    expect(mocks.stopCamera).toHaveBeenCalledWith('http://127.0.0.1:5000', 'slot-1');
    expect(mocks.stopCamera).not.toHaveBeenCalledWith('http://127.0.0.1:5000', 'slot-2');
    expect(mocks.startCamera).toHaveBeenCalledWith('http://127.0.0.1:5000', 'slot-1');

    const lastSync = mocks.syncCameras.mock.calls[mocks.syncCameras.mock.calls.length - 1];
    const payload = lastSync?.[1] as Array<{ id: string; enabled: boolean }>;
    expect(payload).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'slot-1', enabled: true }),
      expect.objectContaining({ id: 'slot-2', enabled: false }),
    ]));

    const savedSlots = JSON.parse(localStorage.getItem('msd-camera-slots-v1')!).slots;
    expect(savedSlots[0]).toMatchObject({ connected: true, autoConnect: true });
    expect(savedSlots[1]).toMatchObject({ connected: false, autoConnect: false });
  });

});
