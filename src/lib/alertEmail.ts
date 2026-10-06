import { supabase } from '@/integrations/supabase/client';

export type AlertSeverityLevel = 'low' | 'medium' | 'high' | 'critical';

const lastSent = new Map<string, number>();
const inFlight = new Set<string>();
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;
const SEND_ERROR_MESSAGE = 'Could not send the alert email. Check email settings and try again.';

export interface AlertEmailResult {
  sent: boolean;
  reason?: string;
  /** Safe for display; never includes raw provider errors or credentials. */
  message?: string;
}

export interface AlertEmailInput {
  householdId: string;
  alertType: string;
  message: string;
  severity: AlertSeverityLevel;
  cameraLabel?: string;
  /** Dashboard alert id so the email and the alert log refer to the same event. */
  alertId?: string;
  /** ISO timestamp of the event as logged in the dashboard. */
  occurredAt?: string;
  /** 0..1 model confidence when the trigger exposes one. */
  confidence?: number;
  /** 0..100 saliency/attention score at the time of the event. */
  saliencyScore?: number;
  /** Short, plain-language description of what triggered the alert. */
  trigger?: string;
  /** Extra key/value detection details rendered as a table in the email. */
  details?: Record<string, string | number | boolean | null | undefined>;
  /** Camera verification frame attached only for verified multimodal distress. */
  snapshotDataUrl?: string;
  cooldownMs?: number;
}

/**
 * Sends an alert email through the backend edge function.
 * The Brevo API key lives only on the server — never in this bundle.
 *
 * Duplicate suppression is two-layered so React re-renders and repeated
 * detection frames can never fan out into multiple emails:
 *  1. an in-flight guard per event key (same tick / concurrent calls)
 *  2. a cooldown window per event key (default 5 minutes)
 */
export async function sendAlertEmail(input: AlertEmailInput): Promise<AlertEmailResult> {
  if (!input.householdId) return { sent: false, reason: 'no_household' };

  const key = `${input.householdId}:${input.alertType}:${input.cameraLabel ?? ''}`;
  const cooldown = input.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const now = Date.now();
  if (inFlight.has(key)) return { sent: false, reason: 'in_flight' };
  const previousSent = lastSent.get(key);
  if (previousSent !== undefined && now - previousSent < cooldown) return { sent: false, reason: 'cooldown' };
  inFlight.add(key);

  const payload = {
    householdId: input.householdId,
    alertType: input.alertType,
    message: input.message,
    severity: input.severity,
    cameraLabel: input.cameraLabel,
    alertId: input.alertId,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    confidence: typeof input.confidence === 'number' ? Math.round(input.confidence * 100) / 100 : undefined,
    saliencyScore: input.saliencyScore,
    trigger: input.trigger,
    snapshotDataUrl: input.snapshotDataUrl,
    details: input.details
      ? Object.fromEntries(
          Object.entries(input.details)
            .filter(([, v]) => v !== undefined && v !== null && v !== '')
            .map(([k, v]) => [k, String(v)]),
        )
      : undefined,
  };

  try {
    const { data, error } = await supabase.functions.invoke('send-alert-email', { body: payload });
    if (error) {
      console.warn('[alertEmail] Alert email request failed.');
      return { sent: false, reason: 'error', message: SEND_ERROR_MESSAGE };
    }
    const result = data as { sent?: unknown; reason?: string; error?: unknown } | null;
    if (result?.sent === true) {
      lastSent.set(key, Date.now());
      return { sent: true };
    }
    if (!result?.error && ['email_disabled', 'below_threshold', 'no_recipients', 'cooldown'].includes(result?.reason ?? '')) {
      return { sent: false, reason: result!.reason };
    }
    return { sent: false, reason: 'error', message: SEND_ERROR_MESSAGE };
  } catch {
    console.warn('[alertEmail] Alert email request failed.');
    return { sent: false, reason: 'error', message: SEND_ERROR_MESSAGE };
  } finally {
    inFlight.delete(key);
  }
}
