import type { DetectionEvent } from '@/types/multicam';

export interface SafetyValidationResult {
  valid: boolean;
  reason: string;
  checks: string[];
}

const finiteConfidence = (value: number) =>
  Number.isFinite(value) && value >= 0 && value <= 1;

/**
 * Final event-validation gate between detectors and the alert dispatcher.
 *
 * Individual detectors still perform their own modality-specific checks. This
 * layer prevents malformed, stale-looking, or under-confident emergency events
 * from becoming notifications if a detector regresses.
 */
export function validateSafetyEvent(
  event: Omit<DetectionEvent, 'id'>,
): SafetyValidationResult {
  const checks: string[] = [];

  if (!event.cameraId || !event.cameraName || !event.type || !event.label) {
    return { valid: false, reason: 'missing_event_identity', checks };
  }
  checks.push('event_identity');

  if (!finiteConfidence(event.confidence)) {
    return { valid: false, reason: 'invalid_confidence', checks };
  }
  checks.push('confidence_range');

  const timestamp = Date.parse(event.timestamp);
  if (!Number.isFinite(timestamp)) {
    return { valid: false, reason: 'invalid_timestamp', checks };
  }
  checks.push('timestamp');

  // History-only detections do not need emergency corroboration.
  if (event.type === 'object' || event.type === 'human' || event.type === 'emotion') {
    return { valid: true, reason: 'informational_detection', checks };
  }

  if (event.type === 'multimodal-distress') {
    if (event.confidence < 0.55) {
      return { valid: false, reason: 'distress_below_validation_threshold', checks };
    }
    if (!/verified distress:/i.test(event.label) || !/\+/.test(event.label)) {
      return { valid: false, reason: 'distress_missing_multimodal_corroboration', checks };
    }
    checks.push('multimodal_distress_corroborated');
  }

  if (event.type === 'fire' || event.type === 'smoke') {
    if (event.confidence < 0.5) {
      return { valid: false, reason: 'fire_below_validation_threshold', checks };
    }
    checks.push('fire_confidence');
  }

  if (event.type === 'audio-distress' && event.confidence < 0.7) {
    return { valid: false, reason: 'audio_below_validation_threshold', checks };
  }

  if (event.type === 'face-distress' && event.confidence < 0.55) {
    return { valid: false, reason: 'face_below_validation_threshold', checks };
  }

  // Saliency/motion alerts are intentionally conservative because lighting
  // changes and shadows are documented limitations of the study.
  if (event.type === 'saliency' && event.confidence < 0.7) {
    return { valid: false, reason: 'saliency_below_validation_threshold', checks };
  }

  checks.push('type_specific_validation');
  return { valid: true, reason: 'validated', checks };
}
