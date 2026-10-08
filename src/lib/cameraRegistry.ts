import {
  CameraConfig,
  DEFAULT_SETTINGS,
  DetectionEvent,
  MultiCamSettings,
} from '@/types/multicam';

const CAMERAS_KEY = 'msd-cameras-v1';
const SETTINGS_KEY = 'msd-multicam-settings-v1';
const EVENTS_KEY = 'msd-detection-events-v1';
const ALERTS_KEY = 'msd-camera-alerts-v1';
export const CAMERA_HISTORY_LIMIT = 50;
const ALERT_TYPES = new Set<DetectionEvent['type']>(['fire', 'smoke', 'face-distress', 'audio-distress', 'multimodal-distress', 'motion-anomaly', 'attention-alert']);

export const isCameraAlert = (event: DetectionEvent) => ALERT_TYPES.has(event.type);

export interface CameraEventHistory {
  events: DetectionEvent[];
  alertEvents: DetectionEvent[];
}

let historyCache: {
  history: CameraEventHistory;
  eventsRaw: string | null;
  alertsRaw: string | null;
} | null = null;

const read = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? ({ ...fallback, ...JSON.parse(raw) } as T) : fallback;
  } catch {
    return fallback;
  }
};

const readArray = <T,>(key: string): T[] => {
  try {
    const raw = localStorage.getItem(key);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
};

const write = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* quota */ }
};

export const slugify = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'cam';

export const loadCameras = (): CameraConfig[] => readArray<CameraConfig>(CAMERAS_KEY);
export const saveCameras = (cams: CameraConfig[]) => write(CAMERAS_KEY, cams);

export const loadSettings = (): MultiCamSettings => read(SETTINGS_KEY, DEFAULT_SETTINGS);
export const saveSettings = (s: MultiCamSettings) => write(SETTINGS_KEY, s);

function readHistoryStorage() {
  try { return { eventsRaw: localStorage.getItem(EVENTS_KEY), alertsRaw: localStorage.getItem(ALERTS_KEY) }; }
  catch { return { eventsRaw: null, alertsRaw: null }; }
}

function parseEventArray(raw: string | null): DetectionEvent[] {
  try {
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function readEventHistory(): CameraEventHistory {
  const source = readHistoryStorage();
  // A failed persistence write must not roll back alerts in this session when
  // the change notification causes every mounted registry hook to reload.
  if (historyCache && source.eventsRaw === historyCache.eventsRaw && source.alertsRaw === historyCache.alertsRaw) {
    return historyCache.history;
  }
  const events = parseEventArray(source.eventsRaw);
  // Migrate alerts before trimming the older, combined 500-entry history.
  const alertEvents = source.alertsRaw !== null ? parseEventArray(source.alertsRaw) : events.filter(isCameraAlert);
  return { events, alertEvents };
}

/** Clips remain usable while either independently bounded history retains them. */
export function revokeUnusedEventClips(
  candidates: Pick<DetectionEvent, 'clipUrl'>[],
  retained: Pick<DetectionEvent, 'clipUrl'>[],
) {
  const active = new Set(retained.map(event => event.clipUrl).filter(Boolean));
  const discarded = new Set(candidates.map(event => event.clipUrl).filter(Boolean));
  for (const url of discarded) {
    if (url?.startsWith('blob:') && !active.has(url)) URL.revokeObjectURL?.(url);
  }
}

export function saveEventHistory(next: CameraEventHistory): CameraEventHistory {
  const previous = readEventHistory();
  const retained = {
    events: next.events.slice(0, CAMERA_HISTORY_LIMIT),
    alertEvents: next.alertEvents.filter(isCameraAlert).slice(0, CAMERA_HISTORY_LIMIT),
  };
  write(EVENTS_KEY, retained.events);
  write(ALERTS_KEY, retained.alertEvents);
  historyCache = { history: retained, ...readHistoryStorage() };
  revokeUnusedEventClips(
    [...previous.events, ...previous.alertEvents, ...next.events, ...next.alertEvents],
    [...retained.events, ...retained.alertEvents],
  );
  return retained;
}

export function loadEventHistory(): CameraEventHistory {
  const history = readEventHistory();
  if (history === historyCache?.history) return history;
  let needsMigration = history.events.length > CAMERA_HISTORY_LIMIT || history.alertEvents.length > CAMERA_HISTORY_LIMIT;
  try { needsMigration ||= localStorage.getItem(ALERTS_KEY) === null; } catch { /* unavailable storage */ }
  return needsMigration ? saveEventHistory(history) : history;
}

export const loadEvents = (): DetectionEvent[] => loadEventHistory().events;
export const saveEvents = (events: DetectionEvent[]) => saveEventHistory({ events, alertEvents: events.filter(isCameraAlert) });

export function makeCamera(partial: Partial<CameraConfig>): CameraConfig {
  const name = partial.name?.trim() || 'New Camera';
  return {
    id: partial.id || crypto.randomUUID(),
    name,
    path: partial.path?.trim() || slugify(name),
    location: partial.location?.trim() || '',
    rtspUrl: partial.rtspUrl?.trim() || '',
    enabled: partial.enabled ?? true,
    aiEnabled: partial.aiEnabled ?? true,
    recording: partial.recording ?? false,
    createdAt: partial.createdAt || new Date().toISOString(),
  };
}
