import { describe, expect, it } from 'vitest';
import { describeKwsCaptureHealth, explainKwsDuration, recentKwsDecision } from '@/lib/kwsLiveDiagnostics';
import type { CctvAudioStatus } from '@/lib/multiCamServer';

const NOW = Date.parse('2026-10-29T06:00:00+08:00');

const audio = (patch: Partial<CctvAudioStatus> = {}): CctvAudioStatus => ({
  thread_running: true,
  connected: true,
  bytes_received: 160000,
  chunks_received: 10,
  last_chunk_at: new Date(NOW - 1000).toISOString(),
  last_transcription_at: null,
  last_transcript: '',
  error: null,
  ffmpeg_error: null,
  recognition_engine: 'custom',
  custom_kws: {
    last_candidate: 'help',
    last_decision: 'duration_mismatch',
    last_duration_ratio: 1.9,
    last_segment_at: new Date(NOW - 2000).toISOString(),
  },
  ...patch,
});

describe('live CCTV microphone/KWS diagnostics', () => {
  it('distinguishes a connected video from a disconnected microphone', () => {
    const stopped = audio({ connected: false, bytes_received: 0 });
    expect(describeKwsCaptureHealth(stopped, true, NOW)).toMatchObject({
      state: 'disconnected', severity: 'error',
    });
    expect(recentKwsDecision(stopped, true, NOW)).toBe(false);
  });

  it('handles unreachable service and missing RTSP audio track', () => {
    expect(describeKwsCaptureHealth(audio(), false, NOW).state).toBe('backend-offline');
    expect(describeKwsCaptureHealth(audio({ has_audio_track: false }), true, NOW).state).toBe('no-track');
    expect(describeKwsCaptureHealth(null, true, NOW).state).toBe('backend-offline');
  });

  it('separates first PCM startup from a stalled but apparently connected stream', () => {
    const pending = audio({ bytes_received: 0, last_chunk_at: null });
    expect(describeKwsCaptureHealth(pending, true, NOW).state).toBe('warming-up');
    const stalled = audio({ last_chunk_at: new Date(NOW - 20_000).toISOString() });
    expect(describeKwsCaptureHealth(stalled, true, NOW).state).toBe('stalled');
    expect(recentKwsDecision(stalled, true, NOW)).toBe(false);
  });

  it('only marks current segmented words as fresh', () => {
    expect(describeKwsCaptureHealth(audio(), true, NOW).state).toBe('streaming');
    expect(recentKwsDecision(audio(), true, NOW)).toBe(true);
    const old = audio({ custom_kws: {
      last_candidate: 'help', last_decision: 'accepted',
      last_segment_at: new Date(NOW - 70_000).toISOString(),
    } });
    expect(recentKwsDecision(old, true, NOW)).toBe(false);
  });

  it('explains short/long duration mismatches without accepting them', () => {
    expect(explainKwsDuration('duration_mismatch', 0.52)).toContain('too short');
    expect(explainKwsDuration('duration_mismatch', 1.9)).toContain('too long');
    expect(explainKwsDuration('duration_mismatch', Number.NaN)).toContain('differs');
    expect(explainKwsDuration('accepted', 1.9)).toBe('');
  });
});
