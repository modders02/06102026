import { describe, expect, it } from 'vitest';
import {
  SIGNIFICANT_EVENT_COOLDOWN_MS, isSignificantHistoryEvent,
  shouldRecordSignificantEvent,
} from '@/lib/significantEvents';
import type { DetectionEvent } from '@/types/multicam';

function evt(type: DetectionEvent['type'], changes: Partial<DetectionEvent> = {}): DetectionEvent {
  return {
    id: 'event-1', cameraId: 'slot-1', cameraName: 'Camera 1',
    location: 'Hall', type, label: type, confidence: 0.95,
    timestamp: '2026-10-25T16:01:00+08:00', ...changes,
  };
}
const verifiedHelp = evt('multimodal-distress', {
  label: 'Verified distress: Angry + "help"',
  priorityScenario: true,
  alertValidation: { status: 'accepted', keyword: 'help',
    emotion: 'Angry', reason: 'Accepted audio and matching face' },
});
const verifiedFire = evt('fire', {
  label: 'Verified fire: visual fire + "fire"',
  fireConfirmed: true, fireRegionRatio: 0.16,
  alertValidation: { status: 'accepted', keyword: 'fire',
    emotion: 'visual fire', reason: 'Accepted word and camera fire region' },
});

describe('incident-only Event History significance policy', () => {
  it('does not log routine footage or emotion labels, regardless of model confidence', () => {
    for (const type of ['object', 'human', 'emotion', 'saliency', 'attention-alert',
      'face-distress', 'audio-distress'] as const) {
      expect(isSignificantHistoryEvent(evt(type, { confidence: 1, label: 'Neutral' }))).toBe(false);
    }
    expect(isSignificantHistoryEvent(evt('object', { label: 'person', confidence: 0.99 }))).toBe(false);
    expect(isSignificantHistoryEvent(evt('audio-distress', { label: 'Wake word: "help"' }))).toBe(false);
  });
  it('retains exact accepted audio+visual evidence and archived alert history', () => {
    expect(isSignificantHistoryEvent(verifiedHelp)).toBe(true);
    expect(isSignificantHistoryEvent(verifiedFire)).toBe(true);
    expect(isSignificantHistoryEvent({ ...verifiedHelp, priorityScenario: false })).toBe(true);
    expect(isSignificantHistoryEvent({ ...verifiedFire, priorityScenario: false })).toBe(true);
    expect(isSignificantHistoryEvent({
      ...verifiedHelp, alertValidation: { ...verifiedHelp.alertValidation!, status: 'rejected' },
    })).toBe(false);
    expect(isSignificantHistoryEvent({
      ...verifiedFire, fireConfirmed: false,
    })).toBe(false);
    // A too-small region is not a verified Camera Alert, but the actual
    // independently confirmed visual fire remains significant in history.
    expect(isSignificantHistoryEvent({
      ...verifiedFire, fireRegionRatio: 0.01,
    })).toBe(true);
  });
  it('logs detector-confirmed visual-only fire/smoke, not unconfirmed candidates', () => {
    expect(isSignificantHistoryEvent(evt('fire', {
      fireConfirmed: true, alertValidation: { status: 'pending', keyword: '',
        emotion: 'visual fire', reason: 'Waiting for accepted fire keyword' },
    }))).toBe(true);
    expect(isSignificantHistoryEvent(evt('fire', { fireConfirmed: false }))).toBe(false);
    expect(isSignificantHistoryEvent(evt('fire', { fireConfirmed: true, confidence: 0.3 }))).toBe(false);
    expect(isSignificantHistoryEvent(evt('smoke', {
      smokeConfirmed: true, alertValidation: { status: 'rejected', keyword: '',
        emotion: 'visual smoke', reason: 'No configured voice fusion for smoke' },
    }))).toBe(true);
    expect(isSignificantHistoryEvent(evt('smoke', { smokeConfirmed: false }))).toBe(false);
  });
  it('only logs higher-confidence plausible collapse/fall motion anomalies', () => {
    expect(isSignificantHistoryEvent(evt('motion-anomaly', {
      label: 'Person collapse detected', confidence: 0.86,
    }))).toBe(true);
    expect(isSignificantHistoryEvent(evt('motion-anomaly', {
      label: 'Routine moving person', confidence: 0.98,
    }))).toBe(false);
    expect(isSignificantHistoryEvent(evt('motion-anomaly', {
      label: 'Person collapse', confidence: 0.60,
    }))).toBe(false);
    expect(isSignificantHistoryEvent(evt('motion-anomaly', {
      label: 'Person collapse', confidence: 0.9,
      alertValidation: { status: 'rejected', keyword: '', emotion: '',
        reason: 'Detection contradicted by validation' },
    }))).toBe(false);
  });
  it('deduplicates repeated visual detections by camera/type without suppressing new cameras', () => {
    const saved = new Map<string, number>();
    const fire = evt('fire', { fireConfirmed: true, label: 'Fire detected' });
    const t = 1_800_000_000_000;
    expect(shouldRecordSignificantEvent(fire, saved, t)).toBe(true);
    expect(shouldRecordSignificantEvent({ ...fire, label: 'Fire detected (night vision)' }, saved, t + 500)).toBe(false);
    expect(shouldRecordSignificantEvent({ ...fire, cameraId: 'slot-2' }, saved, t + 500)).toBe(true);
    expect(shouldRecordSignificantEvent(fire, saved, t + SIGNIFICANT_EVENT_COOLDOWN_MS)).toBe(true);
    expect(shouldRecordSignificantEvent(evt('object', { label: 'person' }), saved, t)).toBe(false);
  });
  it('never cools down independently accepted, verified emergencies', () => {
    const saved = new Map<string, number>();
    expect(shouldRecordSignificantEvent(verifiedHelp, saved, 1000)).toBe(true);
    expect(shouldRecordSignificantEvent({ ...verifiedHelp, id: 'new-trigger' }, saved, 1001)).toBe(true);
    expect(shouldRecordSignificantEvent(verifiedFire, saved, 1000)).toBe(true);
    expect(shouldRecordSignificantEvent({ ...verifiedFire, id: 'new-fire-word' }, saved, 1001)).toBe(true);
  });
});
