import { useEffect, useState } from 'react';
import { CheckCircle2, Clock3, Loader2, ShieldCheck, TriangleAlert, XCircle } from 'lucide-react';
import { useCameraSession } from '@/lib/cameraSessions';
import { formatWakeWordDecision } from '@/lib/wakeWordValidation';
import { facialValidationRequirement, MULTIMODAL_FUSION_WINDOW_MS } from '@/lib/multimodalDistress';
import type { CameraRuntime, DetectionEvent } from '@/types/multicam';

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
  cameraEvidence?: string;
  evaluatedAt?: string;
  startedAt?: string;
  deadlineAt?: string;
}

const normalizeKeyword = (value?: string | null) =>
  (value || '').replace(/_/g, ' ').trim();

const validationState = (status: string): ValidationViewState =>
  status === 'accepted' ? 'validated'
    : status === 'rejected' ? 'rejected'
      : status === 'pending' ? 'pending' : 'waiting';

const validationReason = (reason: string, state: ValidationViewState) => {
  if (reason?.trim()) return formatWakeWordDecision(reason);
  if (state === 'validated') return 'The available evidence was confirmed.';
  if (state === 'rejected') return 'The available evidence was not enough to confirm an alert.';
  if (state === 'pending') return 'Waiting for the remaining checks before confirming an alert.';
  return 'Waiting for a wake word and camera evidence.';
};

function ValidationStatus({ state }: { state: ValidationViewState }) {
  const Icon = state === 'validated' ? CheckCircle2
    : state === 'rejected' ? XCircle
      : state === 'pending' ? TriangleAlert : Clock3;
  const label = state === 'validated' ? 'ACCEPTED'
    : state === 'rejected' ? 'REJECTED'
      : state === 'pending' ? 'PENDING' : 'WAITING';
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-semibold ${
      state === 'validated' ? 'bg-success/10 text-success'
        : state === 'rejected' ? 'bg-destructive/10 text-destructive'
          : state === 'pending' ? 'bg-warning/10 text-warning'
            : 'bg-muted text-muted-foreground'
    }`}>
      <Icon aria-hidden="true" className="h-3.5 w-3.5" />
      {label}
    </span>
  );
}

export function deriveValidationView(runtime: CameraRuntime | null): ValidationView {
  const outcome = runtime?.alertValidation;
  if (outcome) {
    const state = validationState(outcome.status);

    return {
      keyword: normalizeKeyword(outcome.keyword),
      confidence: outcome.confidence,
      decision: outcome.status.toUpperCase(),
      state,
      crossCheck: validationReason(outcome.reason, state),
      cameraEvidence: outcome.emotion?.trim(),
      evaluatedAt: outcome.evaluatedAt,
      startedAt: outcome.startedAt,
      deadlineAt: outcome.deadlineAt,
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
      crossCheck: 'Waiting for a wake word and camera evidence.',
    };
  }

  const accepted = ['accepted', 'accepted_help_90', 'verified', 'verified_help_rescue'].includes(decision);
  const pending = accepted || decision === 'verification_pending';
  return {
    keyword,
    confidence: kws?.last_candidate_confidence ?? 0,
    decision: pending ? 'PENDING' : decision ? 'REJECTED' : 'WAITING',
    state: pending ? 'pending' : decision ? 'rejected' : 'waiting',
    crossCheck: accepted
      ? 'Wake word recognized; waiting for matching camera evidence.'
      : decision ? formatWakeWordDecision(decision) : 'Waiting for the wake-word check to finish.',
    evaluatedAt: kws?.last_segment_at || undefined,
  };
}

function FacialValidationProgress({ state, startedAt, deadlineAt }: {
  state: ValidationViewState;
  startedAt?: string;
  deadlineAt?: string;
}) {
  const [mountedAt] = useState(Date.now);
  const [now, setNow] = useState(Date.now);
  const pending = state === 'pending';
  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => setNow(Date.now()), 40);
    return () => window.clearInterval(timer);
  }, [pending]);

  const start = startedAt && Number.isFinite(Date.parse(startedAt)) ? Date.parse(startedAt) : mountedAt;
  const deadline = deadlineAt && Date.parse(deadlineAt) > start
    ? Date.parse(deadlineAt) : start + MULTIMODAL_FUSION_WINDOW_MS;
  // Completion comes from the detector's decision, never from the UI timer.
  const progress = pending ? Math.max(1, Math.min(99, Math.round(1 + (now - start) / (deadline - start) * 98))) : 100;
  const color = state === 'validated' ? 'bg-success'
    : state === 'rejected' ? 'bg-destructive' : 'bg-primary';

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5">
          {pending && <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />}
          {pending ? 'Checking facial expression…' : 'Facial check complete'}
        </span>
        <span className="font-semibold tabular-nums">{progress}%</span>
      </div>
      <div role="progressbar" aria-label="Facial validation progress" aria-valuemin={1} aria-valuemax={100} aria-valuenow={progress}
        className="h-2 overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full transition-[width] duration-100 ${color}`} style={{ width: `${progress}%` }} />
      </div>
    </div>
  );
}

/** Stored event evidence stays independent of the camera's current check. */
export function RecordedValidationDetails({ validation }: {
  validation: NonNullable<DetectionEvent['alertValidation']>;
}) {
  const state = validationState(validation.status);
  const keyword = normalizeKeyword(validation.keyword);
  return (
    <details className="pt-1 text-xs">
      <summary className="cursor-pointer text-muted-foreground">
        <span className="mr-2">Validation at this event</span>
        <ValidationStatus state={state} />
      </summary>
      <div className="mt-2 space-y-1.5 rounded-lg bg-muted/50 p-2.5">
        <p className="break-words leading-relaxed">{validationReason(validation.reason, state)}</p>
        {keyword && <p><span className="text-muted-foreground">Wake word: </span>"{keyword}"</p>}
        {validation.emotion?.trim() && (
          <p className="break-words"><span className="text-muted-foreground">Evidence: </span>{validation.emotion}</p>
        )}
      </div>
    </details>
  );
}

export default function ValidationLayer({ cameraId, cameraName }: ValidationLayerProps) {
  const { runtime } = useCameraSession(cameraId);
  const validation = deriveValidationView(runtime);
  const requiredExpression = facialValidationRequirement(validation.keyword);
  const showFacialProgress = !!requiredExpression && (
    validation.state === 'pending' || validation.state === 'validated'
    || (validation.state === 'rejected' && runtime?.alertValidation?.sourceDecision === 'accepted')
  );
  const live = runtime?.status === 'online';
  const connectionLabel = live ? 'Live'
    : runtime?.status === 'connecting' ? 'Connecting'
      : runtime?.status === 'error' ? 'Unavailable' : 'Offline';
  const checkedAt = validation.evaluatedAt && Number.isFinite(Date.parse(validation.evaluatedAt)) && Date.parse(validation.evaluatedAt) > 0
    ? validation.evaluatedAt : null;

  return (
    <section
      aria-label="Validation layer"
      className="overflow-hidden rounded-xl border border-border bg-card"
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-bold">Latest validation</h3>
        </div>
        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${live ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground'}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${live ? 'bg-success' : 'bg-muted-foreground'}`} />
          {connectionLabel}
        </span>
      </div>

      <div className="space-y-3 px-4 py-3 text-xs">
        {cameraName && (
          <p className="truncate text-muted-foreground">{cameraName}</p>
        )}

        <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2">
          <dt className="text-muted-foreground">Wake word</dt>
          <dd className="break-words text-right font-semibold">{validation.keyword ? `"${validation.keyword}"` : 'None yet'}</dd>
          {requiredExpression && (
            <>
              <dt className="text-muted-foreground">Required expression</dt>
              <dd className="break-words text-right font-semibold">{requiredExpression}</dd>
            </>
          )}
          {validation.keyword.toLowerCase() === 'fire' && (
            <>
              <dt className="text-muted-foreground">Required evidence</dt>
              <dd className="break-words text-right font-semibold">Large live fire (at least 10% of frame)</dd>
            </>
          )}
          {validation.keyword && validation.state !== 'waiting' && (
            <>
              <dt className="text-muted-foreground">Wake-word confidence</dt>
              <dd className="text-right font-semibold tabular-nums">{(validation.confidence * 100).toFixed(1)}%</dd>
            </>
          )}
          {validation.cameraEvidence && (
            <>
              <dt className="text-muted-foreground">Camera evidence</dt>
              <dd className="break-words text-right font-semibold">{validation.cameraEvidence}</dd>
            </>
          )}
        </dl>

        <div role="status" className="space-y-2 rounded-lg bg-muted/50 p-3">
          {showFacialProgress && (
            <FacialValidationProgress
              key={`${cameraId}:${validation.keyword}:${validation.startedAt || ''}`}
              state={validation.state}
              startedAt={validation.startedAt}
              deadlineAt={validation.deadlineAt}
            />
          )}
          <ValidationStatus state={validation.state} />
          <p className="break-words leading-relaxed">{validation.crossCheck}</p>
        </div>

        {checkedAt && (
          <p className="text-muted-foreground">Last checked: <time dateTime={checkedAt}>{new Date(checkedAt).toLocaleString()}</time></p>
        )}

      </div>
    </section>
  );
}
