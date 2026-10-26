import type { DetectionEvent } from '@/types/multicam';
import { isPriorityCameraAlert } from '@/lib/priorityScenario';
import { historyEmotionMeta } from '@/lib/emotionEvents';

type EventCandidate = Omit<DetectionEvent, 'id'> | DetectionEvent;

export const SIGNIFICANT_EVENT_COOLDOWN_MS = 45_000;
export const EMOTION_EVENT_COOLDOWN_MS = 30_000;
export const EMOTION_MIN_CONFIDENCE = 0.55;
/** Compatibility aliases for prior smile-only history tests. */
export const HAPPY_EVENT_COOLDOWN_MS = EMOTION_EVENT_COOLDOWN_MS;
export const HAPPY_EXPRESSION_MIN_CONFIDENCE = EMOTION_MIN_CONFIDENCE;
export const HAPPY_SMILE_MIN_ACTIVATION = 0.60;

/**
 * Event History logs detector-confirmed incidents AND informational estimates
 * of all seven facial-expression categories. Emotions do not require a matching
 * voice keyword, and never grant permission to alert or notify.
 * Per-camera/category cooldown keeps a continuous face from writing every frame.
 * Facial labels are model observations, not verification of psychological mood.
 */
export function isSignificantHistoryEvent(event: EventCandidate): boolean {
  if (!event || !Number.isFinite(event.confidence)) return false;
  if (event.type === 'emotion') {
    return event.confidence >= EMOTION_MIN_CONFIDENCE
      && event.confidence <= 1
      && historyEmotionMeta(event.label) !== null;
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
    : event.type === 'emotion'
      ? (historyEmotionMeta(event.label)?.emotion ?? event.label.toLowerCase().trim())
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
    ? EMOTION_EVENT_COOLDOWN_MS : SIGNIFICANT_EVENT_COOLDOWN_MS;
  if (last !== undefined && now >= last && now - last < cooldownMs) {
    return false;
  }
  lastRecorded.set(signature, now);
  return true;
}
