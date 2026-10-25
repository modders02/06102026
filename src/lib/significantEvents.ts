import type { DetectionEvent } from '@/types/multicam';
import { isPriorityCameraAlert } from '@/lib/priorityScenario';
import { HAPPY_HISTORY_MIN_CONFIDENCE } from '@/lib/happyHistoryGate';

type EventCandidate = Omit<DetectionEvent, 'id'> | DetectionEvent;

export const SIGNIFICANT_EVENT_COOLDOWN_MS = 45_000;

/**
 * Event History is an INCIDENT log, not a log of per-frame inference.
 *
 * Camera HISTORY is independent of the audio/facial alert-validation state:
 * detector-confirmed visual fire/smoke and credible collapse can be worth
 * documenting even when the audio validation was rejected, absent or pending.
 * Only a true, separately validated multimodal trigger may use the word
 * "Verified". Routine people, neutral expression, raw speech and saliency
 * are not significant events, except a stable high-confidence Happy
 * classifier transition expressly opted into the history policy.
 * Existing fusion still exclusively controls Camera Alerts,
 * notifications and emergency recordings.
 */
export function isSignificantHistoryEvent(event: EventCandidate): boolean {
  if (!event || !Number.isFinite(event.confidence)
      || event.confidence < 0 || event.confidence > 1) return false;
  if (event.type === 'emotion') {
    // Only high-confidence Happy is significant for HISTORY. Other
    // expressions (including Neutral) remain live diagnostics. The upstream
    // facial observation gate also requires two consecutive frames.
    return event.label.trim().toLowerCase() === 'happy'
      && event.confidence >= HAPPY_HISTORY_MIN_CONFIDENCE;
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
  return (event.type === 'fire' || event.type === 'smoke'
      || event.type === 'motion-anomaly' || event.type === 'emotion')
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
  if (last !== undefined && now >= last && now - last < SIGNIFICANT_EVENT_COOLDOWN_MS) {
    return false;
  }
  lastRecorded.set(signature, now);
  return true;
}
