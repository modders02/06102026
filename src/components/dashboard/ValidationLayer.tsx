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
  const finalValidation = runtime?.alertValidation;
  if (finalValidation) {
    const state: ValidationViewState = finalValidation.status === 'accepted'
      ? 'validated'
      : finalValidation.status;
    return {
      keyword: finalValidation.keyword,
      confidence: finalValidation.confidence,
      decision: finalValidation.status.toUpperCase(),
      state,
      crossCheck: finalValidation.reason,
    };
  }

  // Backward-compatible fallback for sessions created before alertValidation
  // was added. New sessions are driven by the pipeline's actual fusion result.
  const kws = runtime?.audio?.custom_kws;
  const latestCandidate = normalizeKeyword(kws?.last_candidate);
  const acceptedKeyword = normalizeKeyword(kws?.last_keyword);
  const decision = kws?.last_decision || '';

  if (!latestCandidate && !acceptedKeyword) {
    return {
      keyword: '',
      confidence: 0,
      decision: 'WAITING',
      state: 'waiting',
      crossCheck: 'Waiting for trained keyword and camera evidence.',
    };
  }

  if (decision && decision !== 'accepted') {
    const reasons: Record<string, string> = {
      negative_not_ready: 'UNKNOWN/non-keyword validation is not ready.',
      duration_mismatch: 'Keyword duration does not match the trained examples.',
      below_threshold: 'Keyword confidence is below the trained acceptance threshold.',
      too_close_to_unknown: 'Candidate is too similar to UNKNOWN/non-keyword speech.',
      insufficient_margin: 'Candidate is too close to another trained keyword.',
      no_ready_candidate: 'No trained keyword candidate is ready.',
    };
    return {
      keyword: latestCandidate,
      confidence: kws?.last_candidate_confidence ?? 0,
      decision: 'REJECTED',
      state: 'rejected',
      crossCheck: reasons[decision] || `Keyword candidate rejected: ${decision}.`,
    };
  }

  const keyword = acceptedKeyword || latestCandidate;
  const confidence = kws?.last_confidence ?? kws?.last_candidate_confidence ?? 0;
  const normalized = keyword.toLowerCase();
  const face = runtime?.faceDistress;
  const hasDistressFace = Boolean(
    face?.detected
    && (face.label === 'Angry' || face.label === 'Frightened'),
  );
  const hasVisualHazard = Boolean(runtime?.fire.detected || runtime?.smoke.detected);

  if (normalized === 'help') {
    if (hasDistressFace) {
      return {
        keyword,
        confidence,
        decision: 'ACCEPTED',
        state: 'validated',
        crossCheck: `Accepted help + ${face?.label || 'distress face'}.`,
      };
    }
    return {
      keyword,
      confidence,
      decision: 'PENDING',
      state: 'pending',
      crossCheck: 'Help accepted; waiting for Angry/Frightened facial evidence.',
    };
  }

  if (normalized === 'fire') {
    if (hasVisualHazard) {
      return {
        keyword,
        confidence,
        decision: 'ACCEPTED',
        state: 'validated',
        crossCheck: 'Accepted fire + current visual fire/smoke evidence.',
      };
    }
    return {
      keyword,
      confidence,
      decision: 'PENDING',
      state: 'pending',
      crossCheck: 'Fire accepted; waiting for current visual hazard evidence.',
    };
  }

  return {
    keyword,
    confidence,
    decision: 'REJECTED',
    state: 'rejected',
    crossCheck: `Accepted "${keyword}", but it is not configured for multimodal alert fusion.`,
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
