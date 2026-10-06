import { describe, expect, it } from 'vitest';
import { cameraStreamEndpoints } from '@/lib/cameraStreamEndpoints';
import type { BackendCameraStatus } from '@/lib/multiCamServer';
import { DEFAULT_SETTINGS, hlsUrlFor, webrtcUrlFor, type CameraConfig } from '@/types/multicam';

const status: BackendCameraStatus = {
  id: 'slot-1', path: 'cam1', name: 'Camera 1', enabled: true,
  ffmpeg: true, hls_ready: true, restarts: 0, error: null,
  stream: 'http://192.168.1.50:8888/cam1/index.m3u8',
  stream_local: 'http://127.0.0.1:8888/cam1/index.m3u8',
  webrtc: 'http://192.168.1.50:8889/cam1/whep',
  webrtc_local: 'http://127.0.0.1:8889/cam1/whep',
};

describe('camera playback endpoint selection', () => {
  it.each(['127.0.0.1', 'localhost', '127.0.1.1', '[::1]'])('uses local playback for a bridge reached at %s', host => {
    expect(cameraStreamEndpoints(status, `http://${host}:5000`)).toEqual({
      streamUrl: status.stream_local, webrtcUrl: status.webrtc_local,
    });
  });

  it('uses the advertised network endpoints when the bridge runs on another device', () => {
    expect(cameraStreamEndpoints(status, 'http://192.168.1.50:5000')).toEqual({
      streamUrl: status.stream, webrtcUrl: status.webrtc,
    });
  });

  it('repairs loopback-only endpoints for remote bridges while preserving their ports and paths', () => {
    const loopbackOnly = { ...status, stream: '', webrtc: '' };
    expect(cameraStreamEndpoints(loopbackOnly, 'http://camera-pc:5000')).toEqual({
      streamUrl: 'http://camera-pc:8888/cam1/index.m3u8',
      webrtcUrl: 'http://camera-pc:8889/cam1/whep',
    });
  });

  it('repairs older bridge responses that advertise loopback as the public address', () => {
    const loopbackPublic = { ...status, stream: status.stream_local, webrtc: status.webrtc_local };
    expect(cameraStreamEndpoints(loopbackPublic, 'http://192.168.1.50:5000')).toEqual({
      streamUrl: status.stream, webrtcUrl: status.webrtc,
    });
  });

  it('keeps intentionally configured public URLs unchanged', () => {
    const proxied = { ...status, stream: 'https://video.example/cam1/index.m3u8?token=abc', webrtc: 'https://video.example/cam1/whep' };
    expect(cameraStreamEndpoints(proxied, 'https://bridge.example')).toEqual({
      streamUrl: proxied.stream, webrtcUrl: proxied.webrtc,
    });
  });

  it('returns empty playback endpoints before a camera has a status', () => {
    expect(cameraStreamEndpoints(null, 'http://127.0.0.1:5000')).toEqual({ streamUrl: '', webrtcUrl: '' });
  });
});

describe('persisted camera playback endpoints', () => {
  const camera: CameraConfig = {
    id: 'slot-1', path: 'cam1', name: 'Camera 1', location: '',
    rtspUrl: 'rtsp://192.168.1.10:554/stream1', enabled: true,
    aiEnabled: true, recording: false, createdAt: '2026-10-04T00:00:00Z',
    streamUrl: status.stream_local, webrtcUrl: status.webrtc_local,
  };
  const remoteSettings = { ...DEFAULT_SETTINGS, pythonServer: 'http://192.168.1.50:5000' };

  it('repairs saved loopback HLS and WebRTC URLs before the Connect page refreshes their status', () => {
    expect(hlsUrlFor(camera, remoteSettings)).toBe(status.stream);
    expect(webrtcUrlFor(camera, remoteSettings)).toBe(status.webrtc);
  });

  it('preserves ports, paths, and tokens on saved loopback endpoints', () => {
    const saved = {
      ...camera,
      streamUrl: 'http://localhost:9090/relay/cam1/index.m3u8?token=abc',
      webrtcUrl: 'http://127.0.0.1:9091/relay/cam1/whep?token=abc',
    };
    expect(hlsUrlFor(saved, remoteSettings)).toBe('http://192.168.1.50:9090/relay/cam1/index.m3u8?token=abc');
    expect(webrtcUrlFor(saved, remoteSettings)).toBe('http://192.168.1.50:9091/relay/cam1/whep?token=abc');
  });

  it('derives WebRTC from the repaired saved HLS host when WebRTC metadata is unavailable', () => {
    expect(webrtcUrlFor({ ...camera, webrtcUrl: '' }, remoteSettings)).toBe(status.webrtc);
  });

  it('uses the remote bridge host for default loopback listeners when no endpoints were saved', () => {
    const unsaved = { ...camera, streamUrl: '', webrtcUrl: '' };
    expect(hlsUrlFor(unsaved, remoteSettings)).toBe(status.stream);
    expect(webrtcUrlFor(unsaved, remoteSettings)).toBe(status.webrtc);
  });

  it('retains saved loopback URLs when playback and the bridge run on the same device', () => {
    expect(hlsUrlFor(camera, DEFAULT_SETTINGS)).toBe(status.stream_local);
    expect(webrtcUrlFor(camera, DEFAULT_SETTINGS)).toBe(status.webrtc_local);
  });

  it('preserves authoritative custom network endpoints', () => {
    const saved = {
      ...camera,
      streamUrl: 'https://video.example/relay/cam1/index.m3u8?token=abc',
      webrtcUrl: 'https://video.example/relay/cam1/whep?token=abc',
    };
    expect(hlsUrlFor(saved, remoteSettings)).toBe(saved.streamUrl);
    expect(webrtcUrlFor(saved, remoteSettings)).toBe(saved.webrtcUrl);
  });

  it('preserves custom network listener hosts when no endpoints were saved', () => {
    const settings = {
      ...remoteSettings,
      mediamtxHost: 'https://video.example:8443/relay',
      webrtcHost: 'https://video.example:8444/relay',
    };
    const unsaved = { ...camera, streamUrl: '', webrtcUrl: '' };
    expect(hlsUrlFor(unsaved, settings)).toBe('https://video.example:8443/relay/cam1/index.m3u8');
    expect(webrtcUrlFor(unsaved, settings)).toBe('https://video.example:8444/relay/cam1/whep');
  });
});
