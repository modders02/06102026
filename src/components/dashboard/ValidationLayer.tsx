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
  const kws = runtime?.audio?.custom_kws;
  const latestCandidate = normalizeKeyword(kws?.last_candidate);
  const acceptedKeyword = normalizeKeyword(runtime?.audioDistress.keyword);
  const keyword = latestCandidate || acceptedKeyword;

  const confidence = latestCandidate
    ? (kws?.last_candidate_confidence ?? 0)
    : (runtime?.audioDistress.confidence ?? 0);

  const decision = kws?.last_decision || (acceptedKeyword ? 'accepted' : '');
  const speechAccepted = decision === 'accepted';

  const normalized = keyword.toLowerCase();
  const isHelp = normalized === 'help';
  const isFire = normalized === 'fire';
  const hasFacialContext = Boolean(runtime?.faceDistress.detected);
  const hasVisualHazard = Boolean(runtime?.fire.detected || runtime?.smoke.detected);
  const distressValidated = speechAccepted && isHelp && hasFacialContext;
  const fireValidated = speechAccepted && isFire && hasVisualHazard;

  const state: ValidationViewState = !keyword
    ? 'waiting'
    : decision && !speechAccepted
      ? 'rejected'
      : distressValidated || fireValidated
        ? 'validated'
        : 'pending';

  const crossCheck = !keyword
    ? 'waiting'
    : fireValidated
      ? 'fire + visual hazard'
      : distressValidated
        ? 'help + Angry/Frightened'
        : speechAccepted
          ? 'accepted keyword; no required context'
          : 'speech not accepted';

  return { keyword, confidence, decision, state, crossCheck };
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
    ? 'Validated'
    : validation.state === 'rejected'
      ? 'Rejected'
      : validation.state === 'pending'
        ? 'Pending'
        : 'Waiting';

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
            {validation.decision || 'waiting'}
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
          Distress alerts require accepted "help" plus Angry/Frightened facial evidence.
        </p>
      </div>
    </section>
  );
}
