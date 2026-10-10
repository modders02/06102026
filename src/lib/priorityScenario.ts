import type { AlertSeverity } from '@/types/dashboard';
import type { DetectionEvent, DetectionType } from '@/types/multicam';

export interface PriorityScenarioDecision {
  priority: boolean;
  emergency: boolean;
  reason: string | null;
}

type PriorityEventInput = Pick<DetectionEvent, 'type' | 'label'> & {
  priorityScenario?: boolean;
};

/**
 * Camera alerts are intentionally narrower than Event History.
 *
 * Priority scenarios are:
 * - verified/standalone fire or smoke hazards,
 * - verified multimodal distress,
 * - a validated person-collapse motion anomaly,
 * - an attention event that explicitly contains a configured priority object,
 * - critical accepted safety speech promoted by the caller.
 *
 * Generic emotion, face-only distress, loud-audio-only attention, rapid motion,
 * ordinary falling objects, and non-critical wake words stay in Event History.
 */
export function classifyPriorityScenario(
  event: PriorityEventInput,
  severity?: AlertSeverity,
): PriorityScenarioDecision {
  if (event.priorityScenario === true) {
    return {
      priority: true,
      emergency: severity === 'critical',
      reason: 'explicit priority scenario',
    };
  }
  if (event.priorityScenario === false) {
    return { priority: false, emergency: false, reason: null };
  }

  if (event.type === 'fire' || event.type === 'smoke') {
    return {
      priority: true,
      emergency: severity === undefined || severity === 'critical',
      reason: 'fire/smoke hazard',
    };
  }

  if (event.type === 'multimodal-distress') {
    return {
      priority: true,
      emergency: severity === undefined || severity === 'critical',
      reason: 'validated multimodal distress',
    };
  }

  if (event.type === 'motion-anomaly' && /person collapse/i.test(event.label)) {
    return {
      priority: true,
      emergency: severity === 'critical',
      reason: 'possible person collapse',
    };
  }

  if (event.type === 'attention-alert' && /priority object/i.test(event.label)) {
    return {
      priority: true,
      emergency: false,
      reason: 'configured priority object',
    };
  }

  if (event.type === 'audio-distress' && severity === 'critical') {
    return {
      priority: true,
      emergency: true,
      reason: 'critical accepted safety speech',
    };
  }

  return { priority: false, emergency: false, reason: null };
}

/** Persisted Camera alerts must carry or intrinsically satisfy priority policy. */
export function isPriorityCameraAlert(event: PriorityEventInput): boolean {
  if (event.priorityScenario === false) return false;
  if (event.priorityScenario === true) return true;
  return classifyPriorityScenario(event).priority;
}

export function isPriorityType(type: DetectionType): boolean {
  return type === 'fire' || type === 'smoke' || type === 'multimodal-distress';
}
