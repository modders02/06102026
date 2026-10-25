import type { AlertSeverity } from '@/types/dashboard';
import type { DetectionEvent, DetectionType } from '@/types/multicam';
import { isKeywordFaceCompatible } from '@/lib/multimodalDistress';
import { LARGE_FIRE_MIN_FRAME_RATIO } from '@/lib/fireFusion';

export interface PriorityScenarioDecision {
  priority: boolean;
  emergency: boolean;
  reason: string | null;
}

type PriorityEventInput = Pick<DetectionEvent, 'type' | 'label' | 'alertValidation' | 'fireConfirmed' | 'fireRegionRatio' | 'smokeConfirmed'> & {
  priorityScenario?: boolean;
};

function isValidatedSpokenDistress(event: PriorityEventInput): boolean {
  if (event.type !== 'multimodal-distress') return false;
  const match = /^verified distress:\s*(Angry|Frightened|Sad)\s*\+\s*"([a-z]+)"\s*$/i.exec(event.label.trim());
  if (!match) return false;
  const validation = event.alertValidation;
  return validation?.status === 'accepted'
    && validation.keyword.trim().toLowerCase() === match[2].toLowerCase()
    && isKeywordFaceCompatible(validation.keyword, validation.emotion)
    && validation.emotion.trim().toLowerCase() === match[1].toLowerCase();
}

function isValidatedSpokenFire(event: PriorityEventInput): boolean {
  const validation = event.alertValidation;
  return event.type === 'fire'
    && event.fireConfirmed === true
    && Number.isFinite(event.fireRegionRatio)
    && event.fireRegionRatio! >= LARGE_FIRE_MIN_FRAME_RATIO
    && event.fireRegionRatio! <= 1
    && validation?.status === 'accepted'
    && validation.keyword.trim().toLowerCase() === 'fire'
    && validation.emotion.trim().toLowerCase() === 'visual fire';
}

/**
 * Camera alerts, notifications, and emergency recordings share this gate.
 * Both the accepted audio keyword and its matching camera evidence must be
 * validated by fusion: a configured keyword + its matching expression, or
 * fire + confirmed large live fire (at least 10% of the frame).
 * Other detections and incomplete/rejected fusion belong in Event History.
 * An explicit priority flag cannot bypass either evidence requirement.
 */
export function classifyPriorityScenario(
  event: PriorityEventInput,
  severity?: AlertSeverity,
): PriorityScenarioDecision {
  if (event.priorityScenario === false) {
    return { priority: false, emergency: false, reason: null };
  }

  const distress = isValidatedSpokenDistress(event);
  const fire = isValidatedSpokenFire(event);
  const priority = distress || fire;
  return {
    priority,
    emergency: priority && (severity === undefined || severity === 'critical'),
    reason: distress
      ? `validated ${event.alertValidation!.keyword.trim().toLowerCase()} + matching distress face`
      : fire ? 'validated fire keyword + confirmed visual fire' : null,
  };
}

/** Recheck persisted evidence using the same policy as new alerts. */
export function isPriorityCameraAlert(event: PriorityEventInput): boolean {
  return classifyPriorityScenario(event).priority;
}

export function isPriorityType(type: DetectionType): boolean {
  return type === 'fire' || type === 'multimodal-distress';
}
