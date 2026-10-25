import type { DetectionEvent } from '@/types/multicam';
import { isPriorityCameraAlert } from '@/lib/priorityScenario';

type EventCandidate = Omit<DetectionEvent, 'id'> | DetectionEvent;

export const SIGNIFICANT_EVENT_COOLDOWN_MS = 45_000;
export const HAPPY_EVENT_COOLDOWN_MS = 120_000;
export const HAPPY_EXPRESSION_MIN_CONFIDENCE = 0.70;
export const HAPPY_SMILE_MIN_ACTIVATION = 0.60;

/**
 * Event History is an INCIDENT log, not a log of per-frame inference.
 *
 * Camera HISTORY is independent of the audio/facial alert-validation state:
 * detector-confirmed visual fire/smoke and credible collapse can be worth
 * documenting even when the audio validation was rejected, absent or pending.
 * Only a true, separately validated multimodal trigger may use the word
 * "Verified". Routine people, neutral expression, raw speech and saliency
 * are not significant events. A high-confidence Happy/smile observation may
 * be retained as an informational facial-expression event, never an alarm.
 * Existing fusion still exclusively controls
 * Camera Alerts, notifications and emergency recordings.
 */
export function isSignificantHistoryEvent(event: EventCandidate): boolean {
  if (!event || !Number.isFinite(event.confidence)) return false;
  if (event.type === 'emotion') {
    // A clearly detected Happy/smile is user-requested history context, not
    // verified internal mood. Other routine/neutral expression observations
    // are deliberately excluded to avoid hundreds of passive history entries.
    return event.label.trim().toLowerCase() === 'happy'
      && event.confidence >= HAPPY_EXPRESSION_MIN_CONFIDENCE;
  }
  if (event.type === 'multimodal-distress') {
    // Archived alerts have priorityScenario=false even though their original
    // accepted evidence remains valid. Do not discard that evidence.
    return isPriorityCameraAlert({ ...event, priorityScenario: undefined });
  }
  if (event.type === 'fire') {
    if (isPriorityCameraAlert({ ...event, priorityScenario: undefined })) return true;
    return event.fireConfirmed === true
      && event.confidence >= 0.55;
  }
  if (event.type === 'smoke') {
    // An unconfigured smoke+word fusion may be marked rejected while the
    // smoke detector independently confirms a visual smoke observation.
    return event.smokeConfirmed === true && event.confidence >= 0.55;
  }
  if (event.type === 'motion-anomaly') {
    return event.confidence >= 0.75
      && /\b(person\s+collapse|person\s+collapsed|person\s+fall(?:en|ing)?|human\s+fall(?:en|ing)?)\b/i.test(event.label);
  }
  return false;
}


/** Permit a significant detector-confirmed visual incident to retain its
 * contemporaneous snapshot regardless of voice/facial validation status.
 * Incomplete or rejected multimodal-distress events never gain this bypass.
 */
export function isIndependentVisualHistoryEvent(event: EventCandidate): boolean {
  return (event.type === 'fire' || event.type === 'smoke' || event.type === 'motion-anomaly')
    && isSignificantHistoryEvent(event);
}

export function significantEventSignature(
  event: Pick<DetectionEvent, 'cameraId' | 'type' | 'label'>,
): string {
  // Group a confirmed fire by episode, including 'night vision' label changes.
  const kind = event.type === 'fire' || event.type === 'smoke'
    ? event.type
    : event.label.toLowerCase().trim().replace(/\s+/g, ' ');
  return `${event.cameraId}:${event.type}:${kind}`;
}

/**
 * Do not throttle separately accepted, verified emergency incidents (each has
 * distinct evidence). For other visual hazards, ignore repeated identical
 * observations within a short rolling window on the same camera only.
 */
export function shouldRecordSignificantEvent(
  event: EventCandidate,
  lastRecorded: Map<string, number>,
  now = Date.now(),
): boolean {
  if (!isSignificantHistoryEvent(event)) return false;
  if (isPriorityCameraAlert({ ...event, priorityScenario: undefined })) return true;
  const signature = significantEventSignature(event);
  const last = lastRecorded.get(signature);
  const cooldownMs = event.type === 'emotion'
    ? HAPPY_EVENT_COOLDOWN_MS : SIGNIFICANT_EVENT_COOLDOWN_MS;
  if (last !== undefined && now >= last && now - last < cooldownMs) {
    return false;
  }
  lastRecorded.set(signature, now);
  return true;
}
