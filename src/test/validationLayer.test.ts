import { describe, expect, it } from 'vitest';
import { deriveValidationView } from '@/components/dashboard/ValidationLayer';
import type { CameraRuntime } from '@/types/multicam';

const runtime = (alertValidation: CameraRuntime['alertValidation']): CameraRuntime => ({
  cameraId: 'slot-1',
  status: 'online',
  error: null,
  fps: 0,
  latencyMs: 0,
  saliencyScore: 0,
  attentionScore: 0,
  objects: [],
  humanCount: 0,
  fire: { detected: false, confidence: 0 },
  smoke: { detected: false, confidence: 0 },
  faceDistress: { detected: false, label: '', confidence: 0 },
  audioDistress: { detected: false, keyword: '', confidence: 0, transcript: '' },
  transcript: '',
  audioListening: true,
  audio: null,
  audioMessage: 'Listening',
  audioTone: 'ok',
  audioBackendReachable: true,
  lastDetectionAt: null,
  detections: 0,
  alerts: 0,
  alertValidation,
});

describe('validation layer decision consistency', () => {
  it('shows ACCEPTED from the exact final alert-validation outcome', () => {
    const view = deriveValidationView(runtime({
      status: 'accepted',
      keyword: 'help',
      confidence: 0.96,
      emotion: 'Frightened',
      emotionConfidence: 0.91,
      reason: 'Frightened + "help" matched within the fusion window.',
      evaluatedAt: '2026-10-11T00:00:00Z',
      sourceDecision: 'accepted',
    }));

    expect(view).toMatchObject({
      decision: 'ACCEPTED',
      state: 'validated',
      keyword: 'help',
      confidence: 0.96,
      crossCheck: 'Frightened + "help" matched within the fusion window.',
    });
  });

  it('shows REJECTED with the exact rejection reason', () => {
    const view = deriveValidationView(runtime({
      status: 'rejected',
      keyword: 'help',
      confidence: 0.61,
      emotion: 'Happy',
      emotionConfidence: 0.95,
      reason: 'Current camera expression is Happy, not Angry/Frightened.',
      evaluatedAt: '2026-10-11T00:00:00Z',
      sourceDecision: 'below_threshold',
    }));

    expect(view).toMatchObject({
      decision: 'REJECTED',
      state: 'rejected',
      keyword: 'help',
      crossCheck: 'Current camera expression is Happy, not Angry/Frightened.',
    });
  });

  it('keeps accepted speech PENDING while required camera evidence is still possible', () => {
    const view = deriveValidationView(runtime({
      status: 'pending',
      keyword: 'help',
      confidence: 0.94,
      emotion: '',
      emotionConfidence: 0,
      reason: 'Accepted "help"; waiting for Angry/Frightened facial evidence.',
      evaluatedAt: '2026-10-11T00:00:00Z',
      sourceDecision: 'accepted',
    }));

    expect(view).toMatchObject({
      decision: 'PENDING',
      state: 'pending',
      keyword: 'help',
    });
    expect(view.crossCheck).toMatch(/waiting for Angry\/Frightened/i);
  });

  it('never reconstructs ACCEPTED from unrelated live fields', () => {
    const value = runtime({
      status: 'rejected',
      keyword: 'help',
      confidence: 0.99,
      emotion: 'Happy',
      emotionConfidence: 0.99,
      reason: 'Validation rejected.',
      evaluatedAt: '2026-10-11T00:00:00Z',
      sourceDecision: 'accepted',
    });
    value.faceDistress = { detected: true, label: 'Angry', confidence: 0.99 };
    value.audioDistress = { detected: true, keyword: 'help', confidence: 0.99, transcript: 'help' };

    expect(deriveValidationView(value)).toMatchObject({
      decision: 'REJECTED',
      state: 'rejected',
    });
  });
});
