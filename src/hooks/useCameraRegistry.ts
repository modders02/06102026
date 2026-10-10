import { useCallback, useEffect, useState } from 'react';
import {
  loadCameras, saveCameras, loadSettings, saveSettings, loadEventHistory, saveEventHistory,
  archiveCameraAlert, isCameraAlert, makeCamera, revokeUnusedEventClips, type CameraEventHistory,
} from '@/lib/cameraRegistry';
import { captureCameraEventSnapshot } from '@/lib/cameraEventSnapshot';
import type { CameraConfig, DetectionEvent, MultiCamSettings } from '@/types/multicam';

const CAMERAS_EVT = 'msd-cameras-changed';
const EVENTS_EVT = 'msd-events-changed';

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
    const captured = { ...evt, snapshot: evt.snapshot || captureCameraEventSnapshot(evt.cameraId) };
    const alert = isCameraAlert(captured);
    commitHistory({
      // Camera Alert is intentionally a single active accepted trigger. When a
      // new valid trigger arrives, archive the previous active alert into Event
      // History instead of stacking it in the Camera Alert panel.
      events: alert
        ? [
            ...current.alertEvents
              .filter(event => event.id !== evt.id)
              .map(archiveCameraAlert),
            ...current.events.filter(event => event.id !== evt.id),
          ]
        : [captured, ...current.events.filter(event => event.id !== evt.id)],
      alertEvents: alert
        ? [captured]
        : current.alertEvents.filter(event => event.id !== evt.id),
    });
  }, [commitHistory]);

  const updateEvent = useCallback((id: string, patch: Partial<DetectionEvent>) => {
    const current = loadEventHistory();
    if (![...current.events, ...current.alertEvents].some(event => event.id === id)) {
      // A recording may finish after both histories have evicted its event.
      revokeUnusedEventClips([patch], [...current.events, ...current.alertEvents]);
      return;
    }
    commitHistory({
      events: current.events.map(event => event.id === id ? { ...event, ...patch } : event),
      alertEvents: current.alertEvents.map(event => event.id === id ? { ...event, ...patch } : event),
    });
  }, [commitHistory]);

  const clearEvents = useCallback(() => {
    commitHistory({ events: [], alertEvents: [] });
  }, [commitHistory]);

  return {
    cameras, settings, events: history.events, alertEvents: history.alertEvents,
    addCamera, updateCamera, deleteCamera, updateSettings, addEvent, updateEvent, clearEvents,
  };
}
