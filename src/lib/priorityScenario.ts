import type { AlertSeverity } from '@/types/dashboard';
import type { DetectionEvent, DetectionType } from '@/types/multicam';

export interface PriorityScenarioDecision {
  priority: boolean;
  emergency: boolean;
  reason: string | null;
}

type PriorityEventInput = Pick<DetectionEvent, 'type' | 'label' | 'alertValidation'> & {
  priorityScenario?: boolean;
};

function isValidatedSpokenDistress(event: PriorityEventInput): boolean {
  if (event.type !== 'multimodal-distress') return false;
  const match = /^verified distress:\s*(Angry|Frightened)\s*\+\s*"help"\s*$/i.exec(event.label.trim());
  if (!match) return false;
  const validation = event.alertValidation;
  if (validation?.status !== 'accepted') return false;
  return validation.keyword.trim().toLowerCase() === 'help'
    && validation.emotion.trim().toLowerCase() === match[1].toLowerCase();
}

function hasAcceptedValidation(event: PriorityEventInput): boolean {
  return event.alertValidation?.status === 'accepted';
}

function shouldOpenEmergencyPopup(
  event: PriorityEventInput,
  severity?: AlertSeverity,
): boolean {
  if (severity !== undefined && severity !== 'critical') return false;
  if (event.type === 'fire' || event.type === 'smoke') return true;
  return isValidatedSpokenDistress(event);
}

/**
 * Camera alerts are intentionally narrower than Event History.
 *
 * Priority scenarios are:
 * - verified/standalone fire or smoke hazards,
 * - verified multimodal distress,
 * - a validated person-collapse motion anomaly,
 * - an attention event that explicitly contains a configured priority object,
 * - accepted safety speech explicitly promoted by the caller.
 *
 * The distress alert rule is strict: only validated Angry/Frightened +
 * accepted "help" is a priority distress alert. Generic audio, "emergency",
 * screaming, face-only distress, motion anomalies, and attention events never
 * satisfy this distress rule. Fire/smoke remain separate hazard alerts.
 */
export function classifyPriorityScenario(
  event: PriorityEventInput,
  severity?: AlertSeverity,
): PriorityScenarioDecision {
  if (event.priorityScenario === true) {
    if (event.type === 'audio-distress' || event.type === 'face-distress') {
      return { priority: false, emergency: false, reason: null };
    }
    if (event.type === 'multimodal-distress') {
      const validatedHelpDistress = isValidatedSpokenDistress(event);
      return {
        priority: validatedHelpDistress,
        emergency: validatedHelpDistress && shouldOpenEmergencyPopup(event, severity),
        reason: validatedHelpDistress ? 'validated help + distress face' : null,
      };
    }
    return {
      priority: true,
      emergency: shouldOpenEmergencyPopup(event, severity),
      reason: 'explicit priority scenario',
    };
  }
  if (event.priorityScenario === false) {
    return { priority: false, emergency: false, reason: null };
  }

  if (event.alertValidation?.status === 'rejected') {
    return { priority: false, emergency: false, reason: null };
  }

  if (event.type === 'fire' || event.type === 'smoke') {
    if (!hasAcceptedValidation(event)) {
      return { priority: false, emergency: false, reason: null };
    }
    return {
      priority: true,
      emergency: shouldOpenEmergencyPopup(event, severity),
      reason: 'fire/smoke hazard',
    };
  }

  if (event.type === 'multimodal-distress') {
    const validatedHelpDistress = isValidatedSpokenDistress(event);
    return {
      priority: validatedHelpDistress,
      emergency: validatedHelpDistress && shouldOpenEmergencyPopup(event, severity),
      reason: validatedHelpDistress ? 'validated help + distress face' : null,
    };
  }

  if (event.type === 'motion-anomaly' && /person collapse/i.test(event.label)) {
    return {
      priority: hasAcceptedValidation(event),
      emergency: false,
      reason: 'possible person collapse',
    };
  }

  if (event.type === 'attention-alert' && /priority object/i.test(event.label)) {
    return {
      priority: hasAcceptedValidation(event),
      emergency: false,
      reason: 'configured priority object',
    };
  }

  // Raw/generic audio is never promoted solely because a caller labels it
  // critical. Accepted household speech can still opt into Camera alerts with
  // priorityScenario=true, but it cannot open the emergency popup by itself.
  if (event.type === 'audio-distress') {
    return {
      priority: false,
      emergency: false,
      reason: null,
    };
  }

  return { priority: false, emergency: false, reason: null };
}

/** Persisted Camera alerts must carry or intrinsically satisfy priority policy. */
export function isPriorityCameraAlert(event: PriorityEventInput): boolean {
  if (event.priorityScenario === false) return false;
  if (event.alertValidation?.status !== 'accepted') return false;
  // Never trust legacy promotion flags for raw audio or multimodal labels:
  // re-validate those against the current strict alert contract.
  if (event.type === 'audio-distress' || event.type === 'face-distress') return false;
  if (event.type === 'multimodal-distress') return isValidatedSpokenDistress(event);
  return classifyPriorityScenario(event).priority;
}

export function isPriorityType(type: DetectionType): boolean {
  return type === 'fire' || type === 'smoke' || type === 'multimodal-distress';
}
