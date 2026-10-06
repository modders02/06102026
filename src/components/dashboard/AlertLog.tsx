import { useState } from 'react';
import type { Alert } from '@/types/dashboard';

interface Snapshot {
  id: string;
  cameraId?: number;
  timestamp: Date;
  dataUrl: string;
  reason: string;
}

interface AlertLogProps {
  alerts: Alert[];
  visible: boolean;
  snapshots?: Snapshot[];
  onAlertClick?: (alert: Alert) => void;
}

export default function AlertLog({ alerts, visible, snapshots = [], onAlertClick }: AlertLogProps) {
  const [viewingAlertId, setViewingAlertId] = useState<string | null>(null);

  if (!visible) return null;

  const severityStyles = {
    low: 'border-l-info text-info',
    medium: 'border-l-warning text-warning',
    high: 'border-l-destructive text-destructive',
    critical: 'border-l-destructive text-destructive alert-pulse',
  };

  const findSnapshot = (alert: Alert): Snapshot | undefined => {
    if (alert.snapshotId) {
      return snapshots.find(s => s.id === alert.snapshotId);
    }
    // Find nearest snapshot within 5 seconds
    const alertTime = alert.timestamp.getTime();
    let best: Snapshot | undefined;
    let bestDist = Infinity;
    for (const snap of snapshots) {
      if (snap.cameraId !== undefined && snap.cameraId !== alert.cameraId) continue;
      const dist = Math.abs(snap.timestamp.getTime() - alertTime);
      if (dist < 5000 && dist < bestDist) {
        bestDist = dist;
        best = snap;
      }
    }
    return best;
  };

  const viewingAlert = alerts.find(alert => alert.id === viewingAlertId);
  const viewingSnapshot = viewingAlert ? findSnapshot(viewingAlert) : undefined;

  return (
    <div className="bg-card rounded-md border border-border panel-glow p-3 space-y-2">
      <div className="flex items-center justify-between bg-card pb-1">
        <span className="text-[10px] font-mono text-primary uppercase tracking-wider">
          Alerts ({alerts.length})
        </span>
        {snapshots.length > 0 && (
          <span className="text-[9px] font-mono text-muted-foreground">
            📸 {snapshots.length} snaps
          </span>
        )}
      </div>

      {/* Snapshot viewer modal */}
      {viewingSnapshot && (
        <div className="space-y-1 p-2 bg-secondary/50 rounded border border-primary/30">
          <div className="flex items-center justify-between">
            <span className="text-[9px] font-mono text-primary">
              📸 {viewingSnapshot.timestamp.toLocaleTimeString()}
            </span>
            <button
              onClick={() => setViewingAlertId(null)}
              className="text-[9px] font-mono text-muted-foreground hover:text-destructive"
            >
              ✕ Close
            </button>
          </div>
          <img
            src={viewingSnapshot.dataUrl}
            alt={viewingSnapshot.reason}
            className="w-full rounded border border-border"
          />
          <span className="text-[8px] font-mono text-destructive">{viewingSnapshot.reason}</span>
        </div>
      )}

      {alerts.length === 0 ? (
        <p className="text-[10px] font-mono text-muted-foreground text-center py-4">No alerts</p>
      ) : (
        <div className="space-y-1 max-h-[168px] overflow-y-auto pr-1">
          {alerts.slice(0, 50).map(alert => {
            const snap = findSnapshot(alert);
            return (
              <div
                key={alert.id}
                onClick={() => {
                  if (snap) setViewingAlertId(alert.id);
                  onAlertClick?.(alert);
                }}
                className={`text-[10px] font-mono px-2 py-1.5 bg-secondary/50 rounded-sm border-l-2 fade-in-up ${severityStyles[alert.severity]} ${
                  snap ? 'cursor-pointer hover:bg-secondary/80 transition-colors' : ''
                }`}
              >
                <div className="flex justify-between items-start gap-2">
                  <span className="opacity-90 flex items-center gap-1">
                    {snap && <button type="button" aria-label={`View snapshot for ${alert.message}`} onClick={event => { event.stopPropagation(); setViewingAlertId(alert.id); }} className="shrink-0 rounded border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><img src={snap.dataUrl} alt={`Snapshot for ${alert.message}`} loading="lazy" className="h-10 w-14 rounded object-cover" /></button>}
                    {alert.message}
                  </span>
                  <span className="text-muted-foreground whitespace-nowrap">
                    {alert.timestamp.toLocaleTimeString()}
                  </span>
                </div>
                <span className="text-muted-foreground">CAM {alert.cameraId}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
