import { useCallback, useEffect, useState } from 'react';
import {
  loadCameras, saveCameras, loadSettings, saveSettings, loadEventHistory, saveEventHistory,
  archiveCameraAlert, isCameraAlert, makeCamera, revokeUnusedEventClips, type CameraEventHistory,
} from '@/lib/cameraRegistry';
import { captureCameraEventSnapshot } from '@/lib/cameraEventSnapshot';
import { EMOTION_EVENT_COOLDOWN_MS, isIndependentVisualHistoryEvent } from '@/lib/significantEvents';
import { historyEmotionMeta } from '@/lib/emotionEvents';
import type { CameraConfig, DetectionEvent, MultiCamSettings } from '@/types/multicam';

const CAMERAS_EVT = 'msd-cameras-changed';
const EVENTS_EVT = 'msd-events-changed';
/** A reappearing spatial face can receive a new session-local track ID.
 * Re-identification is NOT attempted; this merely discards same-expression
 * duplicate events from near-identical face regions in a short time window.
 */
function sameFaceRegion(
  a?: readonly number[], b?: readonly number[],
): boolean {
  if (!a || !b || a.length !== 4 || b.length !== 4) return false;
  if (![...a, ...b].every(Number.isFinite)
      || a[2] <= 0 || a[3] <= 0 || b[2] <= 0 || b[3] <= 0) return false;
  const ix = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  const share = ix * iy / Math.min(a[2] * a[3], b[2] * b[3]);
  const distanceX = Math.abs(a[0] + a[2] / 2 - b[0] - b[2] / 2);
  const distanceY = Math.abs(a[1] + a[3] / 2 - b[1] - b[3] / 2);
  return share >= 0.35
    && distanceX <= Math.max(a[2], b[2]) * 0.65
    && distanceY <= Math.max(a[3], b[3]) * 0.65;
}


/** Shared, localStorage-backed camera registry. Safe to use from many pages. */
export function useCameraRegistry() {
  const [cameras, setCameras] = useState<CameraConfig[]>(loadCameras);
  const [settings, setSettings] = useState<MultiCamSettings>(loadSettings);
  const [history, setHistory] = useState<CameraEventHistory>(loadEventHistory);

  useEffect(() => {
    const sync = () => { setCameras(loadCameras()); setSettings(loadSettings()); };
    const syncEvents = () => setHistory(loadEventHistory());
    const syncStorage = () => { sync(); syncEvents(); };
    window.addEventListener(CAMERAS_EVT, sync);
    window.addEventListener(EVENTS_EVT, syncEvents);
    window.addEventListener('storage', syncStorage);
    return () => {
      window.removeEventListener(CAMERAS_EVT, sync);
      window.removeEventListener(EVENTS_EVT, syncEvents);
      window.removeEventListener('storage', syncStorage);
    };
  }, []);

  const commit = useCallback((next: CameraConfig[]) => {
    saveCameras(next);
    setCameras(next);
    window.dispatchEvent(new Event(CAMERAS_EVT));
  }, []);

  const addCamera = useCallback((partial: Partial<CameraConfig>) => {
    const current = loadCameras();
    const cam = makeCamera(partial);
    // keep MediaMTX paths unique
    let path = cam.path, n = 2;
    while (current.some(c => c.path === path)) path = `${cam.path}-${n++}`;
    const next = [...current, { ...cam, path }];
    commit(next);
    return cam.id;
  }, [commit]);

  const updateCamera = useCallback((id: string, patch: Partial<CameraConfig>) => {
    commit(loadCameras().map(c => (c.id === id ? { ...c, ...patch } : c)));
  }, [commit]);

  const deleteCamera = useCallback((id: string) => {
    commit(loadCameras().filter(c => c.id !== id));
  }, [commit]);

  const updateSettings = useCallback((patch: Partial<MultiCamSettings>) => {
    const next = { ...loadSettings(), ...patch };
    saveSettings(next);
    setSettings(next);
    window.dispatchEvent(new Event(CAMERAS_EVT));
  }, []);

  const commitHistory = useCallback((next: CameraEventHistory) => {
    setHistory(saveEventHistory(next));
    window.dispatchEvent(new Event(EVENTS_EVT));
  }, []);

  const addEvent = useCallback((evt: DetectionEvent) => {
    const current = loadEventHistory();
    if ([...current.events, ...current.alertEvents].some(event => event.id === evt.id)) {
      // Repeated/stale emissions must not recapture the accepted frame or
      // reactivate an older alert. Ongoing changes belong in updateEvent.
      revokeUnusedEventClips([evt], [...current.events, ...current.alertEvents]);
      return;
    }
    // Deduplicate each session-local face track independently, so two people
    // showing the same expression can both appear in history. Legacy events
    // without a track retain the original per-camera deduplication.
    if (evt.type === 'emotion') {
      const category = historyEmotionMeta(evt.label)?.emotion;
      const at = Date.parse(evt.timestamp);
      if (category && Number.isFinite(at) && current.events.some(previous =>
        previous.type === 'emotion'
        && previous.cameraId === evt.cameraId
        && (evt.faceTrackId
          ? previous.faceTrackId === evt.faceTrackId
            || sameFaceRegion(previous.faceBounds, evt.faceBounds)
          : !previous.faceTrackId)
        && historyEmotionMeta(previous.label)?.emotion === category
        && Number.isFinite(Date.parse(previous.timestamp))
        && at >= Date.parse(previous.timestamp)
        && at - Date.parse(previous.timestamp) < EMOTION_EVENT_COOLDOWN_MS
      )) return;
    }
    // A detector-confirmed visual incident is significant historical evidence
    // even when no audio keyword matched. Rejected/incomplete multimodal
    // candidates retain the strict snapshot exclusion.
    const rejectedValidation = evt.alertValidation?.status === 'rejected'
      && !isIndependentVisualHistoryEvent(evt);
    const unconfirmedFire = evt.type === 'fire' && evt.fireConfirmed !== true;
    const unconfirmedSmoke = evt.type === 'smoke' && evt.smokeConfirmed !== true;
    const staleAlert = isCameraAlert(evt) && current.alertEvents.some(event =>
      Date.parse(evt.timestamp) < Date.parse(event.timestamp));
    const captured = {
      ...evt,
      alertValidation: evt.alertValidation && { ...evt.alertValidation },
      ...(rejectedValidation || unconfirmedFire || unconfirmedSmoke
        ? { snapshot: undefined, priorityScenario: false }
        : {
            snapshot: evt.snapshot || (staleAlert ? undefined : captureCameraEventSnapshot(evt.cameraId)),
            ...(staleAlert ? { priorityScenario: false } : {}),
          }),
    };
    const alert = isCameraAlert(captured);
    commitHistory({
      // Camera Alert is intentionally a single active accepted trigger. When a
      // new valid trigger arrives, archive the previous active alert into Event
      // History instead of stacking it in the Camera Alert panel.
      events: alert
        ? [
            ...current.alertEvents
              .filter(event => event.id !== evt.id)
              .map(event => archiveCameraAlert({
                ...event,
                ...current.events.find(item => item.id === event.id),
              })),
            ...current.events.filter(event => event.id !== evt.id
              && !current.alertEvents.some(alertEvent => alertEvent.id === event.id)),
          ]
        : [captured, ...current.events.filter(event => event.id !== evt.id)],
      alertEvents: alert
        ? [captured]
        : current.alertEvents.filter(event => event.id !== evt.id),
    });
  }, [commitHistory]);

  const updateEvent = useCallback((id: string, patch: Partial<DetectionEvent>) => {
    const current = loadEventHistory();
    const existing = current.events.find(event => event.id === id)
      ?? current.alertEvents.find(event => event.id === id);
    if (!existing) {
      // A recording may finish after both histories have evicted its event.
      revokeUnusedEventClips([patch], [...current.events, ...current.alertEvents]);
      return;
    }
    commitHistory({
      // Freeze the active alert at acceptance. Recording results and subsequent
      // updates are one separate, deduplicated Event History record.
      events: [
        archiveCameraAlert({ ...existing, ...patch, id }),
        ...current.events.filter(event => event.id !== id),
      ],
      alertEvents: current.alertEvents,
    });
  }, [commitHistory]);

  const archiveActiveAlert = useCallback((id?: string) => {
    const current = loadEventHistory();
    const archived = current.alertEvents.filter(event => !id || event.id === id);
    if (!archived.length) return;
    commitHistory({
      events: [
        ...archived.map(event => archiveCameraAlert({
          ...event,
          ...current.events.find(item => item.id === event.id),
        })),
        ...current.events.filter(event => !archived.some(alert => alert.id === event.id)),
      ],
      alertEvents: current.alertEvents.filter(event => !archived.some(alert => alert.id === event.id)),
    });
  }, [commitHistory]);

  const clearEvents = useCallback(() => {
    commitHistory({ events: [], alertEvents: [] });
  }, [commitHistory]);

  return {
    cameras, settings, events: history.events, alertEvents: history.alertEvents,
    addCamera, updateCamera, deleteCamera, updateSettings, addEvent, updateEvent, archiveActiveAlert, clearEvents,
  };
}
