import { CheckCircle2, Clock3, ShieldCheck, TriangleAlert, XCircle } from 'lucide-react';
import { useCameraSession } from '@/lib/cameraSessions';
import type { CameraRuntime } from '@/types/multicam';

interface ValidationLayerProps {
  cameraId: string;
  cameraName?: string;
}

export type ValidationViewState = 'waiting' | 'pending' | 'validated' | 'rejected';

export interface ValidationView {
  keyword: string;
  confidence: number;
  decision: string;
  state: ValidationViewState;
  crossCheck: string;
}

const normalizeKeyword = (value?: string | null) =>
  (value || '').replace(/_/g, ' ').trim();

export function deriveValidationView(runtime: CameraRuntime | null): ValidationView {
  const outcome = runtime?.alertValidation;
  if (outcome) {
    const state: ValidationViewState = outcome.status === 'accepted'
      ? 'validated'
      : outcome.status === 'rejected'
        ? 'rejected'
        : outcome.status === 'pending'
          ? 'pending'
          : 'waiting';

    return {
      keyword: outcome.keyword,
      confidence: outcome.confidence,
      decision: outcome.status.toUpperCase(),
      state,
      crossCheck: outcome.reason,
    };
  }

  // Legacy/session-start fallback. Once the pipeline evaluates anything, the
  // authoritative alertValidation result above becomes the only displayed
  // decision so rejected KWS diagnostics cannot disagree with Camera alerts.
  const kws = runtime?.audio?.custom_kws;
  const keyword = normalizeKeyword(kws?.last_candidate);
  const decision = kws?.last_decision || '';
  if (!keyword) {
    return {
      keyword: '',
      confidence: 0,
      decision: 'WAITING',
      state: 'waiting',
      crossCheck: 'Waiting for keyword and camera evidence.',
    };
  }

  const accepted = decision === 'accepted';
  return {
    keyword,
    confidence: kws?.last_candidate_confidence ?? 0,
    decision: accepted ? 'PENDING' : 'REJECTED',
    state: accepted ? 'pending' : 'rejected',
    crossCheck: accepted
      ? 'Accepted keyword; waiting for configured visual/facial evidence.'
      : `Keyword rejected by KWS: ${decision || 'unknown reason'}.`,
  };
}

export default function ValidationLayer({ cameraId, cameraName }: ValidationLayerProps) {
  const { runtime } = useCameraSession(cameraId);
  const validation = deriveValidationView(runtime);

  const StatusIcon = validation.state === 'validated'
    ? CheckCircle2
    : validation.state === 'rejected'
      ? XCircle
      : validation.state === 'pending'
        ? TriangleAlert
        : Clock3;

  const statusLabel = validation.state === 'validated'
    ? 'ACCEPTED'
    : validation.state === 'rejected'
      ? 'REJECTED'
      : validation.state === 'pending'
        ? 'PENDING'
        : 'WAITING';

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
          <span className="text-muted-foreground">Confidence:</span>
          <span className="font-mono font-semibold">
            {validation.keyword ? `${(validation.confidence * 100).toFixed(1)}%` : '—'}
          </span>

          <span className="text-muted-foreground">Decision:</span>
          <span className="max-w-44 text-right font-mono font-semibold">
            {validation.decision || 'WAITING'}
          </span>

          <span className="text-muted-foreground">Cross-check:</span>
          <span className="max-w-44 text-right font-mono font-semibold">{validation.crossCheck}</span>
        </div>

        <div className="pt-1">
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-1 font-semibold ${
              validation.state === 'validated'
                ? 'bg-success/10 text-success'
                : validation.state === 'rejected'
                  ? 'bg-destructive/10 text-destructive'
                  : validation.state === 'pending'
                    ? 'bg-warning/10 text-warning'
                    : 'bg-muted text-muted-foreground'
            }`}
          >
            <StatusIcon className="h-3.5 w-3.5" />
            {statusLabel}
          </span>
        </div>

        <p className="text-muted-foreground">
          Validation shows the same final decision used by the alert pipeline.
        </p>
      </div>
    </section>
  );
}
