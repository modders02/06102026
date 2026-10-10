import { describe, expect, it } from 'vitest';
import { classifyPriorityScenario, isPriorityCameraAlert } from '@/lib/priorityScenario';

describe('priority scenario camera alert policy', () => {
  it('keeps ordinary detections and facial expressions out of Camera alerts', () => {
    expect(isPriorityCameraAlert({ type: 'object', label: 'person' })).toBe(false);
    expect(isPriorityCameraAlert({ type: 'human', label: '1 person(s)' })).toBe(false);
    expect(isPriorityCameraAlert({ type: 'emotion', label: 'Frightened' })).toBe(false);
    expect(isPriorityCameraAlert({ type: 'face-distress', label: 'Frightened' })).toBe(false);
  });

  it('does not promote generic motion or loud-audio attention into Camera alerts', () => {
    expect(isPriorityCameraAlert({ type: 'motion-anomaly', label: 'Rapid unexplained motion' })).toBe(false);
    expect(isPriorityCameraAlert({ type: 'motion-anomaly', label: 'Possible falling object: bottle' })).toBe(false);
    expect(isPriorityCameraAlert({ type: 'attention-alert', label: 'Attention alert: loud audio (α=70)' })).toBe(false);
  });

  it('accepts the explicit priority scenarios', () => {
    expect(isPriorityCameraAlert({ type: 'fire', label: 'Fire detected' })).toBe(true);
    expect(isPriorityCameraAlert({ type: 'smoke', label: 'Smoke detected' })).toBe(true);
    expect(isPriorityCameraAlert({
      type: 'multimodal-distress',
      label: 'Verified distress: Frightened + "help"',
    })).toBe(true);
    expect(isPriorityCameraAlert({
      type: 'motion-anomaly',
      label: 'Possible person collapse',
    })).toBe(true);
    expect(isPriorityCameraAlert({
      type: 'attention-alert',
      label: 'Attention alert: priority object (α=55)',
    })).toBe(true);
  });

  it('requires critical accepted speech before it becomes a priority emergency', () => {
    expect(classifyPriorityScenario(
      { type: 'audio-distress', label: 'Wake word: "danger"' },
      'high',
    )).toMatchObject({ priority: false, emergency: false });

    expect(classifyPriorityScenario(
      { type: 'audio-distress', label: 'Wake word: "call 911"' },
      'critical',
    )).toMatchObject({ priority: true, emergency: true });
  });

  it('allows callers to explicitly demote or promote a scenario', () => {
    expect(isPriorityCameraAlert({
      type: 'fire',
      label: 'diagnostic fire candidate',
      priorityScenario: false,
    })).toBe(false);

    expect(classifyPriorityScenario({
      type: 'audio-distress',
      label: 'validated custom emergency scenario',
      priorityScenario: true,
    }, 'critical')).toMatchObject({ priority: true, emergency: true });
  });
});
