import type { AlertSeverity } from '@/types/dashboard';
import type { DetectionEvent, DetectionType } from '@/types/multicam';

export interface PriorityScenarioDecision {
  priority: boolean;
  emergency: boolean;
  reason: string | null;
}

type PriorityEventInput = Pick<DetectionEvent, 'type' | 'label' | 'alertValidation' | 'fireConfirmed' | 'smokeConfirmed'> & {
  priorityScenario?: boolean;
};

function isValidatedSpokenDistress(event: PriorityEventInput): boolean {
  if (event.type !== 'multimodal-distress') return false;
  const match = /^verified distress:\s*(Angry|Frightened)\s*\+\s*"help"\s*$/i.exec(event.label.trim());
  if (!match) return false;
  const validation = event.alertValidation;
  return validation?.status === 'accepted'
    && validation.keyword.trim().toLowerCase() === 'help'
    && validation.emotion.trim().toLowerCase() === match[1].toLowerCase();
}

function isValidatedSpokenFire(event: PriorityEventInput): boolean {
  const validation = event.alertValidation;
  return event.type === 'fire'
    && event.fireConfirmed === true
    && validation?.status === 'accepted'
    && validation.keyword.trim().toLowerCase() === 'fire'
    && validation.emotion.trim().toLowerCase() === 'visual fire';
}

/**
 * Camera alerts, notifications, and emergency recordings share this gate.
 * Both the accepted audio keyword and its matching camera evidence must be
 * validated by fusion: help + Angry/Frightened, or fire + confirmed visual fire.
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
      ? 'validated help + distress face'
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
