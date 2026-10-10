import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Bell, CameraOff, Film, Filter, FolderOpen, Maximize2, Settings, Trash2 } from 'lucide-react';
import { useCameraRegistry } from '@/hooks/useCameraRegistry';
import { useCameraSlots } from '@/hooks/useCameraSlots';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { clipFolderSupported, getClipFolderLabel, getClipSeconds, pickClipFolder, restoreClipFolder, setClipSeconds } from '@/lib/clipRecorder';
import { CAMERA_HISTORY_LIMIT } from '@/lib/cameraRegistry';
import type { DetectionEvent, DetectionType } from '@/types/multicam';
import { historyEmotionMeta } from '@/lib/emotionEvents';
import { isPriorityCameraAlert } from '@/lib/priorityScenario';
import ValidationLayer from '@/components/dashboard/ValidationLayer';

const typeIcon: Record<DetectionType, string> = {
  fire: '🔥', smoke: '💨', human: '🧍', object: '📦',
  'face-distress': '😨', 'audio-distress': '🗣', 'multimodal-distress': '🆘', 'motion-anomaly': '⚠️', 'attention-alert': '🔔', emotion: '🙂', saliency: '✨',
};

/** Camera alerts, past detections, and emergency clips shown beside live feeds. */
export default function DashboardEvents({
  initialFilter,
  validationCameraId,
  validationCameraName,
}: {
  initialFilter?: string;
  validationCameraId?: string;
  validationCameraName?: string;
}) {
  const { events, alertEvents, clearEvents } = useCameraRegistry();
  const { activeSlots } = useCameraSlots();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedFilter = searchParams.get('events') || initialFilter || 'all';
  const [filter, setFilter] = useState(requestedFilter);
  const [showSettings, setShowSettings] = useState(false);
  const [folder, setFolder] = useState(getClipFolderLabel);
  const [seconds, setSeconds] = useState(getClipSeconds);
  const [folderError, setFolderError] = useState('');
  const [viewingId, setViewingId] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const initialFolder = getClipFolderLabel();
    void restoreClipFolder().then(value => {
      if (mounted && value !== initialFolder) setFolder(value);
    }).catch(() => { if (mounted && initialFolder) setFolder(''); });
    return () => { mounted = false; };
  }, []);

  useEffect(() => { setFilter(requestedFilter); }, [requestedFilter]);

  const cameraOptions = useMemo(() => {
    const names = new Map(activeSlots.map(slot => [`slot-${slot.index}`, slot.name || `Camera ${slot.index}`]));
    for (const event of [...events, ...(alertEvents || [])]) if (!names.has(event.cameraId)) names.set(event.cameraId, event.cameraName);
    if (filter !== 'all' && !names.has(filter)) names.set(filter, /^slot-\d+$/.test(filter) ? `Camera ${filter.slice(5)}` : filter);
    return Array.from(names.entries());
  }, [activeSlots, events, alertEvents, filter]);
  const filtered = useMemo(() => filter === 'all' ? events : events.filter(event => event.cameraId === filter), [events, filter]);
  const alerts = useMemo(() => (alertEvents || events).filter(event => isPriorityCameraAlert(event) && (filter === 'all' || event.cameraId === filter)), [alertEvents, events, filter]);
  // Camera alerts is a live scene view, not an alert-history list.
  // Histories still retain older alerts internally, but only the newest
  // triggered scene for the selected camera is shown here.
  const activeAlert = alerts[0];
  const viewingEvent = viewingId ? [...events, ...(alertEvents || [])].find(event => event.id === viewingId) : undefined;

  const selectFilter = (value: string) => {
    setFilter(value);
    const next = new URLSearchParams(searchParams);
    next.set('events', value);
    setSearchParams(next, { replace: true });
  };

  const chooseFolder = async () => {
    setFolderError('');
    try { setFolder(await pickClipFolder()); }
    catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return;
      setFolderError(error instanceof Error ? error.message : 'Could not open the folder picker.');
    }
  };

  const snapshotButton = (event: DetectionEvent) => event.snapshot ? (
    <button type="button" onClick={() => setViewingId(event.id)} aria-label={`View snapshot: ${event.label} from ${event.cameraName}`} title="View snapshot" className="group relative shrink-0 overflow-hidden rounded-lg border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
      <img src={event.snapshot} loading="lazy" alt={`${event.label} snapshot from ${event.cameraName}`} className="h-14 w-20 object-cover transition-opacity group-hover:opacity-80" />
      <Maximize2 aria-hidden="true" className="absolute bottom-1 right-1 h-3.5 w-3.5 rounded bg-black/60 p-0.5 text-white" />
    </button>
  ) : (
    <div role="img" aria-label={`Snapshot unavailable for ${event.cameraName}`} title="Snapshot unavailable" className="flex h-14 w-20 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground"><CameraOff className="h-5 w-5" /></div>
  );

  return (
    <section id="camera-events" className="space-y-4 scroll-mt-5" aria-label="Camera alerts and event history">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-3">
        <Filter className="h-4 w-4 shrink-0 text-muted-foreground" />
        <label htmlFor="camera-event-filter" className="sr-only">Filter events by camera</label>
        <select id="camera-event-filter" value={filter} onChange={event => selectFilter(event.target.value)} className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm">
          <option value="all">All cameras</option>
          {cameraOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <button onClick={() => setShowSettings(value => !value)} title="Recording settings" aria-label="Recording settings" aria-expanded={showSettings} className={`rounded-lg p-2 hover:bg-muted ${showSettings ? 'text-primary' : 'text-muted-foreground'}`}><Settings className="h-4 w-4" /></button>
        <button onClick={clearEvents} title="Clear event history" aria-label="Clear event history" className="rounded-lg p-2 text-muted-foreground hover:bg-muted"><Trash2 className="h-4 w-4" /></button>
      </div>

      {showSettings && (
        <div className="space-y-3 rounded-xl border border-border bg-card p-4">
          <h3 className="text-sm font-semibold">Emergency recording settings</h3>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={chooseFolder} disabled={!clipFolderSupported()} className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-semibold hover:bg-muted disabled:opacity-60"><FolderOpen className="h-4 w-4" /> Choose folder</button>
            <span className="text-sm text-muted-foreground">{folder ? 'Folder selected.' : 'No folder selected.'}</span>
          </div>
          {!clipFolderSupported() && <p className="text-xs text-muted-foreground">Folder selection is unavailable in this browser.</p>}
          {folderError && <p role="alert" className="text-xs text-destructive">{folderError}</p>}
          <label className="block text-sm font-semibold">Clip length: {seconds} seconds
            <input aria-label="Emergency clip length in seconds" type="range" min={5} max={30} step={5} value={seconds} onChange={event => { const value = Number(event.target.value); setSeconds(value); setClipSeconds(value); }} className="mt-2 w-full" />
          </label>
        </div>
      )}

      {activeAlert && (
        <div className="overflow-hidden rounded-xl border border-destructive/30 bg-card">
          <div className="flex items-center gap-2 border-b border-border px-4 py-3">
            <Bell className="h-4 w-4 text-destructive" />
            <h3 className="text-sm font-bold">Camera alert</h3>
            <span className="ml-auto rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-semibold text-destructive">
              Triggered scene
            </span>
          </div>

          <div className="space-y-3 p-3">
            {activeAlert.snapshot ? (
              <button
                type="button"
                onClick={() => setViewingId(activeAlert.id)}
                aria-label={`View triggered scene: ${activeAlert.label} from ${activeAlert.cameraName}`}
                className="group relative block w-full overflow-hidden rounded-lg border border-destructive/20 bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <img
                  src={activeAlert.snapshot}
                  alt={`Triggered alert scene for ${activeAlert.label} from ${activeAlert.cameraName}`}
                  className="aspect-video w-full object-cover transition-opacity group-hover:opacity-90"
                />
                <span className="absolute bottom-2 right-2 inline-flex items-center gap-1 rounded-md bg-black/65 px-2 py-1 text-[11px] font-semibold text-white">
                  <Maximize2 className="h-3.5 w-3.5" />
                  View scene
                </span>
              </button>
            ) : (
              <div className="flex aspect-video w-full items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground">
                <div className="text-center">
                  <CameraOff className="mx-auto h-6 w-6" />
                  <p className="mt-2 text-xs">Triggered scene unavailable</p>
                </div>
              </div>
            )}

            <div className="space-y-1">
              <p className="break-words text-sm font-semibold">
                {typeIcon[activeAlert.type]} {activeAlert.label}
              </p>
              <p className="break-words text-xs text-muted-foreground">
                <span className="font-semibold text-foreground">{activeAlert.cameraName}</span>
                {activeAlert.location ? ` · ${activeAlert.location}` : ''}
              </p>
              <p className="text-xs text-muted-foreground">
                {(activeAlert.confidence * 100).toFixed(0)}% confidence · {new Date(activeAlert.timestamp).toLocaleString()}
              </p>
              {activeAlert.clipError && <p className="text-xs text-destructive">{activeAlert.clipError}</p>}
            </div>
          </div>
        </div>
      )}

      {validationCameraId && (
        <ValidationLayer cameraId={validationCameraId} cameraName={validationCameraName} />
      )}

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3"><Film className="h-4 w-4 text-primary" /><h3 className="text-sm font-bold">Event history</h3><span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{filtered.length}</span></div>
        <div className="max-h-[420px] divide-y divide-border overflow-y-auto">
          {filtered.length === 0 && <p className="p-4 text-sm text-muted-foreground">No events recorded for {filter === 'all' ? 'your cameras' : 'this camera'}.</p>}
          {filtered.slice(0, CAMERA_HISTORY_LIMIT).map(event => {
            const emotion = event.type === 'emotion' ? historyEmotionMeta(event.label) : null;
            return (
            <div key={event.id} className={`flex items-start gap-3 p-3 ${emotion?.rowClass ?? ''}`}>
              {event.clipUrl ? (
                <video src={event.clipUrl} controls preload="none" poster={event.snapshot} aria-label={`${event.label} recording from ${event.cameraName}`} className="h-16 w-24 shrink-0 rounded-lg border border-border bg-background" />
              ) : event.snapshot ? (
                snapshotButton(event)
              ) : (
                <div className="flex h-14 w-20 shrink-0 items-center justify-center rounded-lg bg-muted text-lg" aria-hidden="true">{typeIcon[event.type]}</div>
              )}
              <div className="min-w-0 space-y-0.5">
                <p className={`truncate text-sm font-semibold ${emotion?.labelClass ?? ''}`}>
                  {emotion ? `${emotion.icon} ${emotion.label}` : event.label}
                </p>
                <p className="truncate text-xs text-muted-foreground">{event.cameraName}{event.location ? ` · ${event.location}` : ''} · {(event.confidence * 100).toFixed(0)}%</p>
                <p className="text-xs text-muted-foreground">{new Date(event.timestamp).toLocaleString()}</p>
                {event.clipFile && <p className="flex items-center gap-1 truncate text-xs text-primary"><Film className="h-3.5 w-3.5 shrink-0" /> {event.clipFile}</p>}
                {event.clipError && <p className="text-xs text-destructive">{event.clipError}</p>}
              </div>
            </div>
            );
          })}
        </div>
      </div>
      <Dialog open={!!viewingEvent?.snapshot} onOpenChange={open => { if (!open) setViewingId(null); }}>
        <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{viewingEvent?.label}</DialogTitle>
            <DialogDescription>{viewingEvent && `${viewingEvent.cameraName}${viewingEvent.location ? ` · ${viewingEvent.location}` : ''} · ${new Date(viewingEvent.timestamp).toLocaleString()} · ${(viewingEvent.confidence * 100).toFixed(0)}% confidence`}</DialogDescription>
          </DialogHeader>
          {viewingEvent?.snapshot && <img src={viewingEvent.snapshot} alt={`${viewingEvent.label} snapshot from ${viewingEvent.cameraName}`} className="max-h-[65vh] w-full rounded-lg bg-muted object-contain" />}
        </DialogContent>
      </Dialog>
    </section>
  );
}
