import type { BackendCameraStatus } from '@/lib/multiCamServer';

function isLoopback(hostname: string) {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost')
    || /^127\./.test(host) || host === '[::1]' || host === '::1';
}

function serverHostname(server: string) {
  try { return new URL(server).hostname; } catch { return ''; }
}

/** Repair older or persisted loopback addresses when the camera bridge is remote. */
export function cameraPlaybackUrl(url: string, server: string) {
  const playbackUrl = url.trim();
  const serverHost = serverHostname(server);
  if (!playbackUrl || !serverHost || isLoopback(serverHost)) return playbackUrl;
  // Loopback on another device points at the viewer instead of the bridge.
  try {
    const endpoint = new URL(playbackUrl);
    if (isLoopback(endpoint.hostname)) {
      endpoint.hostname = serverHost;
      return endpoint.href;
    }
  } catch { /* Preserve custom endpoints rather than manufacturing a path. */ }
  return playbackUrl;
}

/** Select playback addresses for the machine actually hosting the camera bridge. */
export function cameraStreamEndpoints(status: BackendCameraStatus | null, server: string) {
  const localBridge = isLoopback(serverHostname(server));
  const choose = (publicUrl?: string, localUrl?: string) => cameraPlaybackUrl(
    (localBridge ? localUrl?.trim() || publicUrl?.trim() : publicUrl?.trim() || localUrl?.trim()) || '',
    server,
  );

  return {
    streamUrl: choose(status?.stream, status?.stream_local),
    webrtcUrl: choose(status?.webrtc, status?.webrtc_local),
  };
}
