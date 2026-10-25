import { describe, expect, it } from 'vitest';
import { classifyPriorityScenario, isPriorityCameraAlert } from '@/lib/priorityScenario';
import type { DetectionEvent } from '@/types/multicam';
import { KEYWORD_FACE_PAIRINGS } from '@/lib/multimodalDistress';

const validation = (keyword: string, emotion: string, status: 'pending' | 'accepted' | 'rejected' = 'accepted') => ({
  status, reason: 'Fusion result', keyword, emotion,
});

const fire = {
  type: 'fire' as const,
  label: 'Verified fire: visual fire + "fire"',
  fireConfirmed: true,
  fireRegionRatio: 0.15,
  alertValidation: validation('fire', 'visual fire'),
};
const distress = {
  type: 'multimodal-distress' as const,
  label: 'Verified distress: Angry + "help"',
  alertValidation: validation('help', 'Angry'),
};

describe('camera alerts require both accepted audio and matching camera evidence', () => {
  it.each([fire, distress, {
    ...distress,
    label: 'Verified distress: Frightened + "help"',
    alertValidation: validation('help', 'Frightened'),
  }])('permits a fully accepted $type fusion', event => {
    expect(isPriorityCameraAlert(event)).toBe(true);
    expect(classifyPriorityScenario(event, 'critical')).toMatchObject({ priority: true, emergency: true });
    expect(classifyPriorityScenario(event, 'high')).toMatchObject({ priority: true, emergency: false });
  });

  it.each(['pending', 'rejected', undefined] as const)('blocks fusion with validation %s', status => {
    for (const event of [fire, distress]) {
      const candidate = { ...event, priorityScenario: true,
        alertValidation: status ? { ...event.alertValidation, status } : undefined };
      expect(isPriorityCameraAlert(candidate)).toBe(false);
      expect(classifyPriorityScenario(candidate, 'critical')).toMatchObject({ priority: false, emergency: false });
    }
  });

  it.each([
    { ...fire, alertValidation: validation('', 'visual fire') },
    { ...fire, alertValidation: validation('help', 'visual fire') },
    { ...fire, alertValidation: validation('fire', 'visual fire candidate') },
    { ...fire, fireConfirmed: false },
    { ...fire, fireConfirmed: undefined },
    { ...fire, fireRegionRatio: 0.01 },
    { ...fire, fireRegionRatio: undefined },
    { ...fire, fireRegionRatio: Number.NaN },
    { ...fire, fireRegionRatio: 2 },
  ])('blocks incomplete or mismatched fire evidence %#', event => {
    expect(isPriorityCameraAlert(event)).toBe(false);
    expect(classifyPriorityScenario({ ...event, priorityScenario: true }, 'critical'))
      .toMatchObject({ priority: false, emergency: false });
  });

  it.each([
    validation('help', 'Happy'),
    validation('help', 'Frightened'),
    validation('fire', 'Angry'),
    validation('', 'Angry'),
    validation('emergency', 'Angry'),
  ])('blocks mismatched distress evidence %#', alertValidation => {
    expect(isPriorityCameraAlert({ ...distress, priorityScenario: true, alertValidation })).toBe(false);
  });

  it('does not manufacture fusion from a label', () => {
    expect(isPriorityCameraAlert({ ...distress, alertValidation: undefined })).toBe(false);
    expect(isPriorityCameraAlert({ ...distress, label: 'Verified distress: Angry + "emergency"' })).toBe(false);
  });

  it.each([
    ['object', 'person'],
    ['human', '1 person(s)'],
    ['emotion', 'Frightened'],
    ['face-distress', 'Frightened'],
    ['audio-distress', 'Safety word: "help"'],
    ['smoke', 'Smoke detected'],
    ['motion-anomaly', 'Possible person collapse'],
    ['attention-alert', 'Attention alert: priority object + loud audio'],
  ] as [DetectionEvent['type'], string][])('keeps %s observations in Event history even with a promotion flag', (type, label) => {
    const event = { type, label, priorityScenario: true, smokeConfirmed: true,
      alertValidation: validation('help', 'Frightened') };
    expect(isPriorityCameraAlert(event)).toBe(false);
    expect(classifyPriorityScenario(event, 'critical')).toMatchObject({ priority: false, emergency: false });
  });

  it('keeps archived accepted fusion in Event history', () => {
    for (const event of [fire, distress]) {
      expect(isPriorityCameraAlert({ ...event, priorityScenario: false })).toBe(false);
    }
  });

  it.each(Object.entries(KEYWORD_FACE_PAIRINGS).flatMap(([keyword, expressions]) =>
    expressions.map(emotion => [keyword, emotion] as const),
  ))('uses the same %s + %s pairing for alerts, recordings, and notifications', (keyword, emotion) => {
    const event = { ...distress, label: `Verified distress: ${emotion} + "${keyword}"`,
      alertValidation: validation(keyword, emotion) };
    expect(isPriorityCameraAlert(event)).toBe(true);
    expect(isPriorityCameraAlert({ ...event, alertValidation: validation(keyword, 'Happy') })).toBe(false);
    expect(isPriorityCameraAlert({ ...event, alertValidation: validation(keyword, emotion, 'pending') })).toBe(false);
  });
});
