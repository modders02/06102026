import { describe, expect, it } from 'vitest';
import { deriveValidationView } from '@/components/dashboard/ValidationLayer';
import type { CameraRuntime } from '@/types/multicam';

const runtime = (patch: Partial<CameraRuntime> = {}) => ({
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
  ...patch,
}) as CameraRuntime;

describe('validation layer decision consistency', () => {
  it('shows ACCEPTED from the exact final alert-validation outcome', () => {
    const view = deriveValidationView(runtime({
      alertValidation: {
        status: 'accepted',
        keyword: 'help',
        confidence: 0.96,
        emotion: 'Frightened',
        emotionConfidence: 0.91,
        reason: 'Frightened + "help" matched within the fusion window.',
        evaluatedAt: '2026-10-10T10:00:00.000Z',
        sourceDecision: 'accepted',
      },
      // A stale diagnostic candidate must not override the actual alert result.
      audio: {
        thread_running: true,
        connected: true,
        chunks_received: 1,
        bytes_received: 1,
        last_chunk_at: null,
        last_transcription_at: null,
        last_transcript: '',
        error: null,
        ffmpeg_error: null,
        custom_kws: {
          last_candidate: 'help',
          last_candidate_confidence: 0.5,
          last_decision: 'below_threshold',
        },
      },
    }));

    expect(view).toMatchObject({
      decision: 'ACCEPTED',
      state: 'validated',
      keyword: 'help',
      confidence: 0.96,
    });
    expect(view.crossCheck).toContain('Frightened');
  });

  it('shows REJECTED with the backend KWS rejection reason', () => {
    const view = deriveValidationView(runtime({
      audio: {
        thread_running: true,
        connected: true,
        chunks_received: 1,
        bytes_received: 1,
        last_chunk_at: null,
        last_transcription_at: null,
        last_transcript: '',
        error: null,
        ffmpeg_error: null,
        custom_kws: {
          last_candidate: 'help',
          last_candidate_confidence: 0.61,
          last_decision: 'below_threshold',
        },
      },
    }));

    expect(view).toMatchObject({
      decision: 'REJECTED',
      state: 'rejected',
      keyword: 'help',
    });
    expect(view.crossCheck).toMatch(/below the trained acceptance threshold/i);
  });

  it('keeps accepted help pending until required facial evidence exists', () => {
    const view = deriveValidationView(runtime({
      audio: {
        thread_running: true,
        connected: true,
        chunks_received: 1,
        bytes_received: 1,
        last_chunk_at: null,
        last_transcription_at: null,
        last_transcript: 'help',
        error: null,
        ffmpeg_error: null,
        custom_kws: {
          last_candidate: 'help',
          last_candidate_confidence: 0.95,
          last_keyword: 'help',
          last_confidence: 0.95,
          last_decision: 'accepted',
        },
      },
    }));

    expect(view).toMatchObject({
      decision: 'PENDING',
      state: 'pending',
      keyword: 'help',
    });
    expect(view.crossCheck).toMatch(/waiting for Angry\/Frightened/i);
  });

  it('rejects accepted keywords that are not configured for facial-distress fusion', () => {
    const view = deriveValidationView(runtime({
      audio: {
        thread_running: true,
        connected: true,
        chunks_received: 1,
        bytes_received: 1,
        last_chunk_at: null,
        last_transcription_at: null,
        last_transcript: 'emergency',
        error: null,
        ffmpeg_error: null,
        custom_kws: {
          last_candidate: 'emergency',
          last_candidate_confidence: 0.97,
          last_keyword: 'emergency',
          last_confidence: 0.97,
          last_decision: 'accepted',
        },
      },
    }));

    expect(view).toMatchObject({
      decision: 'REJECTED',
      state: 'rejected',
      keyword: 'emergency',
    });
    expect(view.crossCheck).toMatch(/not configured/i);
  });
});
