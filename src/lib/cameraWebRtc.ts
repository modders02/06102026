export interface CameraWebRtcCallbacks {
  onStream: (stream: MediaStream) => void;
  onError: (error: Error) => void;
}

// These counters are cumulative seconds. Only their changes between samples
// describe the current queue, rather than an average over the whole session.
function intervalDelayMs(total?: number, previousTotal?: number, count?: number, previousCount?: number) {
  if (![total, previousTotal, count, previousCount].every(value => typeof value === 'number' && Number.isFinite(value))) return 0;
  const emitted = count! - previousCount!;
  const delay = total! - previousTotal!;
  return emitted > 0 && delay >= 0 ? delay * 1000 / emitted : 0;
}

function preferCurrentFrames(receiver?: RTCRtpReceiver) {
  if (!receiver || !('jitterBufferTarget' in receiver)) return;
  try {
    // Request the browser's minimum network-safe buffer for both synchronized
    // tracks: https://www.w3.org/TR/webrtc/#dom-rtcrtpreceiver-jitterbuffertarget
    (receiver as RTCRtpReceiver & { jitterBufferTarget: number | null }).jitterBufferTarget = 0;
  } catch { /* Unsupported receiver hints must never prevent playback. */ }
}

/** Read a MediaMTX WHEP stream directly, without a segmented video buffer. */
export function openCameraWebRtc(url: string, callbacks: CameraWebRtcCallbacks): { close: () => void } {
  const peer = new RTCPeerConnection({ bundlePolicy: 'max-bundle' });
  const controller = new AbortController();
  let closed = false;
  let failed = false;
  let sessionUrl: string | null = null;
  let disconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let delayTimer: ReturnType<typeof setInterval> | undefined;
  let previousVideoStats: RTCInboundRtpStreamStats | undefined;
  let delayedSamples = 0;
  let checkingDelay = false;
  const tracks = new MediaStream();
  const deleteSession = () => {
    const target = sessionUrl;
    sessionUrl = null;
    if (target) void fetch(target, { method: 'DELETE', keepalive: true }).catch(() => {});
  };
  const close = () => {
    if (closed) return;
    closed = true;
    controller.abort();
    clearTimeout(disconnectTimer);
    clearInterval(delayTimer);
    peer.ontrack = null;
    peer.onconnectionstatechange = null;
    peer.close();
    tracks.getTracks().forEach(track => track.stop());
    deleteSession();
  };
  const fail = (error: unknown) => {
    if (closed || failed) return;
    failed = true;
    close();
    callbacks.onError(error instanceof Error ? error : new Error('Realtime camera connection failed.'));
  };
  preferCurrentFrames(peer.addTransceiver('video', { direction: 'recvonly' })?.receiver);
  preferCurrentFrames(peer.addTransceiver('audio', { direction: 'recvonly' })?.receiver);
  peer.ontrack = event => {
    if (closed) return;
    preferCurrentFrames(event.receiver);
    // Use one stable stream for both tracks, including servers without msid.
    if (!tracks.getTracks().some(track => track.id === event.track.id)) tracks.addTrack(event.track);
    callbacks.onStream(tracks);
  };
  peer.onconnectionstatechange = () => {
    clearTimeout(disconnectTimer);
    if (peer.connectionState !== 'connected') {
      previousVideoStats = undefined;
      delayedSamples = 0;
    }
    if (peer.connectionState === 'failed') fail(new Error('Realtime camera connection failed.'));
    else if (peer.connectionState === 'disconnected') {
      disconnectTimer = setTimeout(() => fail(new Error('Realtime camera connection was interrupted.')), 2500);
    }
  };

  const checkPlaybackDelay = async () => {
    if (closed || checkingDelay || peer.connectionState !== 'connected' || typeof peer.getStats !== 'function') return;
    checkingDelay = true;
    try {
      const report = await peer.getStats();
      if (closed || peer.connectionState !== 'connected') return;
      const current = Array.from(report.values()).find(stats =>
        stats.type === 'inbound-rtp' && (stats.kind ?? stats.mediaType) === 'video',
      ) as RTCInboundRtpStreamStats | undefined;
      const previous = previousVideoStats;
      previousVideoStats = current;
      if (!current || !previous || current.id !== previous.id) {
        delayedSamples = 0;
        return;
      }
      // Frames can keep arriving at a normal FPS while old pictures accumulate
      // in the jitter buffer or decoder. The frozen-video watchdog misses this.
      const delay = Math.max(
        intervalDelayMs(current.jitterBufferDelay, previous.jitterBufferDelay,
          current.jitterBufferEmittedCount, previous.jitterBufferEmittedCount),
        intervalDelayMs(current.totalProcessingDelay, previous.totalProcessingDelay,
          current.framesDecoded, previous.framesDecoded),
      );
      delayedSamples = delay > 1000 ? delayedSamples + 1 : 0;
      if (delayedSamples >= 3) {
        const error = new Error('Realtime video fell behind. Reconnecting to the latest frames…');
        error.name = 'CameraPlaybackDelayError';
        fail(error);
      }
    } catch {
      // Optional statistics must not interrupt an otherwise usable camera.
      previousVideoStats = undefined;
      delayedSamples = 0;
    } finally { checkingDelay = false; }
  };
  delayTimer = setInterval(() => { void checkPlaybackDelay(); }, 1000);

  void (async () => {
    try {
      await peer.setLocalDescription(await peer.createOffer());
      if (closed) return;
      // Submit gathered host candidates in the offer. LAN playback needs no
      // external STUN service or continuous trickle-ICE HTTP requests.
      if (peer.iceGatheringState !== 'complete') {
        await new Promise<void>((resolve, reject) => {
          const finish = () => {
            clearTimeout(timer);
            peer.removeEventListener('icegatheringstatechange', gathered);
            controller.signal.removeEventListener('abort', aborted);
          };
          const gathered = () => {
            if (peer.iceGatheringState === 'complete') { finish(); resolve(); }
          };
          const aborted = () => { finish(); reject(new DOMException('Camera closed.', 'AbortError')); };
          const timer = setTimeout(() => { finish(); resolve(); }, 1500);
          peer.addEventListener('icegatheringstatechange', gathered);
          controller.signal.addEventListener('abort', aborted, { once: true });
          gathered();
          if (controller.signal.aborted) aborted();
        });
      }
      if (closed) return;
      const sdp = peer.localDescription?.sdp;
      if (!sdp) throw new Error('Unable to prepare realtime camera playback.');
      const timeout = setTimeout(() => controller.abort(), 8000);
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST', headers: { 'Content-Type': 'application/sdp' },
          body: sdp, signal: controller.signal,
        });
      } finally { clearTimeout(timeout); }
      if (!response.ok) {
        const detail = (await response.text()).trim().slice(0, 300);
        throw new Error(`Realtime camera unavailable (HTTP ${response.status})${detail ? `: ${detail}` : '.'}`);
      }
      const location = response.headers.get('Location');
      if (location) {
        const resource = new URL(location, url);
        if (resource.origin !== new URL(url).origin) throw new Error('Camera returned an invalid playback session.');
        sessionUrl = resource.href;
      }
      if (closed) { deleteSession(); return; }
      const answer = await response.text();
      if (closed) { deleteSession(); return; }
      await peer.setRemoteDescription({ type: 'answer', sdp: answer });
    } catch (error) { fail(error); }
  })();
  return { close };
}
