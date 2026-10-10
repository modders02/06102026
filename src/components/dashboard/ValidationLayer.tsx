import { CheckCircle2, Clock3, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useCameraSession } from '@/lib/cameraSessions';

interface ValidationLayerProps {
  cameraId: string;
  cameraName?: string;
}

export default function ValidationLayer({ cameraId, cameraName }: ValidationLayerProps) {
  const { runtime } = useCameraSession(cameraId);

  const keyword = runtime?.audioDistress.keyword?.trim() || '';
  const confidence = runtime?.audioDistress.confidence ?? 0;
  const hasFacialContext = Boolean(runtime?.faceDistress.detected);
  const hasVisualHazard = Boolean(runtime?.fire.detected || runtime?.smoke.detected);
  const hasContext = hasFacialContext || hasVisualHazard;

  const state = !keyword
    ? 'waiting'
    : hasContext
      ? 'validated'
      : 'pending';

  const crossCheck = !keyword
    ? 'waiting'
    : hasVisualHazard
      ? 'voice + visual hazard'
      : hasFacialContext
        ? 'voice + facial context'
        : 'voice only';

  const StatusIcon = state === 'validated'
    ? CheckCircle2
    : state === 'pending'
      ? TriangleAlert
      : Clock3;

  return (
    <section
      aria-label="Validation layer"
      className="overflow-hidden rounded-xl border border-border bg-card"
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-bold">Validation layer</h3>
        </div>
        <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-xs font-semibold text-success">
          <span className="h-1.5 w-1.5 rounded-full bg-success" />
          Active
        </span>
      </div>

      <div className="space-y-2 px-4 py-3 text-xs">
        {cameraName && (
          <p className="truncate text-muted-foreground">{cameraName}</p>
        )}

        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1">
          <span className="text-muted-foreground">Speech verification:</span>
          <span className="font-mono font-semibold">{keyword || 'None'}</span>

          <span className="text-muted-foreground">Confidence:</span>
          <span className="font-mono font-semibold">
            {keyword ? `${(confidence * 100).toFixed(1)}%` : '—'}
          </span>

          <span className="text-muted-foreground">Cross-check:</span>
          <span className="max-w-44 text-right font-mono font-semibold">{crossCheck}</span>
        </div>

        <div className="pt-1">
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-1 font-semibold ${
              state === 'validated'
                ? 'bg-success/10 text-success'
                : state === 'pending'
                  ? 'bg-warning/10 text-warning'
                  : 'bg-muted text-muted-foreground'
            }`}
          >
            <StatusIcon className="h-3.5 w-3.5" />
            {state === 'validated' ? 'Validated' : state === 'pending' ? 'Pending' : 'Waiting'}
          </span>
        </div>

        <p className="text-muted-foreground">
          Confirms safety keywords before alert escalation.
        </p>
      </div>
    </section>
  );
}
