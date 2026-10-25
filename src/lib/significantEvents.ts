import type { DetectionEvent } from '@/types/multicam';
import { isPriorityCameraAlert } from '@/lib/priorityScenario';

type EventCandidate = Omit<DetectionEvent, 'id'> | DetectionEvent;

export const SIGNIFICANT_EVENT_COOLDOWN_MS = 45_000;

/**
 * Event History is an INCIDENT log, not a log of per-frame inference.
 *
 * A confirmed visual fire/smoke or credible collapse can be important without
 * an accepted keyword. Those are HISTORY-ONLY, not validated Camera Alerts.
 * Audio-only, expression-only, routine people/objects and saliency are not
 * incidents. The already validated face+word / fire+word fusion remains the
 * only path into Camera Alerts.
 */
export function isSignificantHistoryEvent(event: EventCandidate): boolean {
  if (!event || !Number.isFinite(event.confidence)) return false;
  if (event.type === 'multimodal-distress') {
    // Archived alerts have priorityScenario=false even though their original
    // accepted evidence remains valid. Do not discard that evidence.
    return isPriorityCameraAlert({ ...event, priorityScenario: undefined });
  }
  if (event.type === 'fire') {
    if (isPriorityCameraAlert({ ...event, priorityScenario: undefined })) return true;
    return event.fireConfirmed === true
      && event.confidence >= 0.55
      && event.alertValidation?.status !== 'rejected';
  }
  if (event.type === 'smoke') {
    // An unconfigured smoke+word fusion may be marked rejected while the
    // smoke detector independently confirms a visual smoke observation.
    return event.smokeConfirmed === true && event.confidence >= 0.55;
  }
  if (event.type === 'motion-anomaly') {
    return event.confidence >= 0.75
      && /\b(person\s+collapse|person\s+collapsed|person\s+fall(?:en|ing)?|human\s+fall(?:en|ing)?)\b/i.test(event.label)
      && event.alertValidation?.status !== 'rejected';
  }
  return false;
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
