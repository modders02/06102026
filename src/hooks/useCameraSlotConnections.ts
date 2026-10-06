import { useEffect, useRef } from 'react';
import { loadServerHost, serverUrlFor, slotCamera, slotRtsp, type CameraSlot } from '@/hooks/useCameraSlots';
import { cameraStreamEndpoints } from '@/lib/cameraStreamEndpoints';
import { getMultiStatus, startCamera, stopCamera, syncCameras, type BackendCameraStatus } from '@/lib/multiCamServer';

const POLL_MS = 2500;
const RETRY_MS = 10000;
const ready = (camera: BackendCameraStatus | undefined) =>
  !!camera?.ffmpeg && !!camera.hls_ready && !!(camera.stream_local || camera.stream);

/** Restore camera intent even when the connection dialog has never opened. */
export function useCameraSlotConnections(
  slots: CameraSlot[],
  updateSlot: (index: number, patch: Partial<CameraSlot>) => void,
) {
  const latest = useRef({ slots, updateSlot });
  latest.current = { slots, updateSlot };
  const inFlight = useRef(false);
  const attempts = useRef(new Map<number, number>());
  const server = serverUrlFor(loadServerHost());

  useEffect(() => {
    let cancelled = false;
    const apply = (cameras: BackendCameraStatus[], observedSlots: CameraSlot[]) => {
      if (cancelled) return;
      for (const slot of latest.current.slots) {
        if (!slot.ip.trim()) continue;
        const observed = observedSlots.find(camera => camera.index === slot.index);
        if (!observed || slotRtsp(observed) !== slotRtsp(slot)) continue;
        const status = cameras.find(camera => camera.id === `slot-${slot.index}`);
        const connected = !!slot.autoConnect && ready(status);
        const endpoints = cameraStreamEndpoints(status ?? null, server);
        const streamUrl = connected ? endpoints.streamUrl : '';
        const webrtcUrl = connected ? endpoints.webrtcUrl : '';
        if (!!slot.connected !== connected || (slot.streamUrl || '') !== streamUrl || (slot.webrtcUrl || '') !== webrtcUrl) {
          const patch = { connected, streamUrl, webrtcUrl };
          // React may batch the offline and ready updates within one restore.
          // Compare subsequent status against the write we just made as well.
          latest.current.slots = latest.current.slots.map(camera => camera.index === slot.index ? { ...camera, ...patch } : camera);
          latest.current.updateSlot(slot.index, patch);
        }
        if (status?.ffmpeg) attempts.current.delete(slot.index);
      }
    };
    const poll = async () => {
      if (cancelled || inFlight.current || !latest.current.slots.some(slot => slot.ip.trim())) return;
      inFlight.current = true;
      const observedSlots = latest.current.slots;
      try {
        const status = await getMultiStatus(server);
        if (cancelled) return;
        apply(status.cameras, observedSlots);
        const configured = latest.current.slots.filter(slot => slot.ip.trim());
        const restore = configured.filter(slot => slot.autoConnect
          && !status.cameras.some(camera => camera.id === `slot-${slot.index}` && camera.ffmpeg)
          && Date.now() - (attempts.current.get(slot.index) ?? -Infinity) >= RETRY_MS);
        if (!restore.length) return;

        // Sync the entire registry: the bridge removes any omitted cameras.
        // Doing this before every restore also uses current saved credentials.
        for (const slot of restore) attempts.current.set(slot.index, Date.now());
        const result = await syncCameras(server, configured.map(slot => ({
          ...slotCamera(slot), enabled: !!slot.autoConnect,
        })));
        if (cancelled || !result.success) return;
        for (const slot of restore) {
          const current = latest.current.slots.find(camera => camera.index === slot.index);
          if (cancelled || !current?.ip.trim() || !current.autoConnect) continue;
          if (slotRtsp(current) !== slotRtsp(slot)) {
            attempts.current.delete(slot.index);
            continue;
          }
          await startCamera(server, `slot-${slot.index}`);
          // An explicit Disconnect/Stop may arrive while start waits for HLS.
          const afterStart = latest.current.slots.find(camera => camera.index === slot.index);
          if (!afterStart?.autoConnect || slotRtsp(afterStart) !== slotRtsp(slot)) {
            await stopCamera(server, `slot-${slot.index}`);
            attempts.current.delete(slot.index);
          }
        }
        if (!cancelled) apply((await getMultiStatus(server)).cameras, configured);
      } catch {
        // Startup can take longer than the renderer. Keep intent and retry
        // when the service becomes reachable instead of requiring Connect.
        if (!cancelled) apply([], observedSlots);
      } finally {
        inFlight.current = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, POLL_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [server]);
}
