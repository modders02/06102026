import { describe, expect, it } from 'vitest';
import { classifyPriorityScenario, isPriorityCameraAlert } from '@/lib/priorityScenario';

const accepted = (keyword: string, emotion: string, reason = 'accepted') => ({
  status: 'accepted' as const,
  reason,
  keyword,
  emotion,
});

const rejected = (keyword: string, emotion: string, reason = 'rejected') => ({
  status: 'rejected' as const,
  reason,
  keyword,
  emotion,
});

describe('priority scenario camera alert policy', () => {
  it('keeps ordinary detections and facial expressions out of Camera alerts', () => {
    expect(isPriorityCameraAlert({ type: 'object', label: 'person' })).toBe(false);
    expect(isPriorityCameraAlert({ type: 'human', label: '1 person(s)' })).toBe(false);
    expect(isPriorityCameraAlert({ type: 'emotion', label: 'Frightened' })).toBe(false);
    expect(isPriorityCameraAlert({ type: 'face-distress', label: 'Frightened' })).toBe(false);
  });

  it('does not promote unvalidated motion or audio attention into Camera alerts', () => {
    expect(isPriorityCameraAlert({ type: 'motion-anomaly', label: 'Possible person collapse' })).toBe(false);
    expect(isPriorityCameraAlert({ type: 'attention-alert', label: 'Attention alert: priority object (α=55)' })).toBe(false);
    expect(isPriorityCameraAlert({ type: 'attention-alert', label: 'Attention alert: loud audio (α=70)' })).toBe(false);
  });

  it('accepts only scenarios carrying an ACCEPTED validation outcome', () => {
    expect(isPriorityCameraAlert({
      type: 'fire',
      label: 'Fire detected',
      fireConfirmed: true,
      alertValidation: accepted('', 'visual fire'),
    })).toBe(true);

    expect(isPriorityCameraAlert({
      type: 'fire',
      label: 'Fire candidate only',
      fireConfirmed: false,
      alertValidation: accepted('', 'visual fire candidate'),
    })).toBe(false);

    expect(isPriorityCameraAlert({
      type: 'smoke',
      label: 'Smoke detected',
      smokeConfirmed: true,
      alertValidation: accepted('', 'visual smoke'),
    })).toBe(true);

    expect(isPriorityCameraAlert({
      type: 'smoke',
      label: 'Smoke candidate only',
      smokeConfirmed: false,
      alertValidation: accepted('', 'visual smoke candidate'),
    })).toBe(false);

    expect(isPriorityCameraAlert({
      type: 'multimodal-distress',
      label: 'Verified distress: Frightened + "help"',
      alertValidation: accepted('help', 'Frightened'),
    })).toBe(true);

    expect(isPriorityCameraAlert({
      type: 'motion-anomaly',
      label: 'Possible person collapse',
      alertValidation: accepted('', 'motion'),
    })).toBe(true);

    expect(isPriorityCameraAlert({
      type: 'attention-alert',
      label: 'Attention alert: priority object (α=55)',
      alertValidation: accepted('', 'priority object'),
    })).toBe(true);
  });

  it('never promotes a REJECTED validation result', () => {
    expect(isPriorityCameraAlert({
      type: 'fire',
      label: 'Fire detected',
      alertValidation: rejected('', 'visual fire candidate', 'visual verification failed'),
    })).toBe(false);

    expect(isPriorityCameraAlert({
      type: 'multimodal-distress',
      label: 'Verified distress: Angry + "help"',
      alertValidation: rejected('help', 'Angry', 'keyword rejected'),
    })).toBe(false);
  });

  it('rejects a camera-alert label that does not match the validated evidence', () => {
    expect(isPriorityCameraAlert({
      type: 'multimodal-distress',
      label: 'Verified distress: Angry + "help"',
      alertValidation: accepted('help', 'Happy'),
    })).toBe(false);

    expect(isPriorityCameraAlert({
      type: 'multimodal-distress',
      label: 'Verified distress: Angry + "help"',
      alertValidation: accepted('help', 'Frightened'),
    })).toBe(false);

    expect(isPriorityCameraAlert({
      type: 'multimodal-distress',
      label: 'Verified distress: Angry + "emergency"',
      alertValidation: accepted('emergency', 'Angry'),
    })).toBe(false);
  });

  it('opens the emergency popup only for an accepted configured emergency', () => {
    expect(classifyPriorityScenario({
      type: 'multimodal-distress',
      label: 'Verified distress: Angry + "help"',
      alertValidation: accepted('help', 'Angry'),
    }, 'critical')).toMatchObject({ priority: true, emergency: true });

    expect(classifyPriorityScenario({
      type: 'multimodal-distress',
      label: 'Verified distress: Frightened + "help"',
      alertValidation: accepted('help', 'Frightened'),
    }, 'critical')).toMatchObject({ priority: true, emergency: true });

    expect(classifyPriorityScenario({
      type: 'multimodal-distress',
      label: 'Verified distress: Frightened + "emergency"',
      alertValidation: accepted('emergency', 'Frightened'),
    }, 'critical')).toMatchObject({ priority: false, emergency: false });

    expect(classifyPriorityScenario({
      type: 'audio-distress',
      label: 'Wake word: "call 911"',
    }, 'critical')).toMatchObject({ priority: false, emergency: false });

    expect(classifyPriorityScenario({
      type: 'fire',
      label: 'Fire detected',
      fireConfirmed: true,
      alertValidation: accepted('', 'visual fire'),
    }, 'critical')).toMatchObject({ priority: true, emergency: true });

    expect(classifyPriorityScenario({
      type: 'fire',
      label: 'Visual fire candidate + smoke',
      fireConfirmed: false,
      alertValidation: accepted('', 'visual fire candidate'),
    }, 'critical')).toMatchObject({ priority: false, emergency: false });

    expect(classifyPriorityScenario({
      type: 'smoke',
      label: 'Smoke detected',
      smokeConfirmed: true,
      alertValidation: accepted('', 'visual smoke'),
    }, 'critical')).toMatchObject({ priority: true, emergency: true });

    expect(classifyPriorityScenario({
      type: 'smoke',
      label: 'Smoke candidate only',
      priorityScenario: true,
      smokeConfirmed: false,
      alertValidation: accepted('', 'visual smoke candidate'),
    }, 'critical')).toMatchObject({ priority: false, emergency: false });
  });

  it('does not let priorityScenario bypass detector-confirmed fire', () => {
    expect(classifyPriorityScenario({
      type: 'fire',
      label: 'Fire candidate only',
      priorityScenario: true,
      fireConfirmed: false,
      alertValidation: accepted('', 'visual fire candidate'),
    }, 'critical')).toMatchObject({ priority: false, emergency: false });
  });

  it('does not let priorityScenario bypass the validation result', () => {
    expect(classifyPriorityScenario({
      type: 'fire',
      label: 'diagnostic fire candidate',
      priorityScenario: true,
      alertValidation: rejected('', 'fire candidate'),
    }, 'critical')).toMatchObject({ priority: false, emergency: false });

    expect(classifyPriorityScenario({
      type: 'audio-distress',
      label: 'validated custom emergency scenario',
      priorityScenario: true,
    }, 'critical')).toMatchObject({ priority: false, emergency: false });
  });
});
