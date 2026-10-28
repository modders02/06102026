import type { CctvAudioStatus } from '@/lib/multiCamServer';

export type KwsCaptureState = 'backend-offline' | 'no-track' | 'disconnected' | 'warming-up' | 'stalled' | 'streaming';

export interface KwsCaptureHealth {
  state: KwsCaptureState;
  message: string;
  severity: 'ok' | 'wait' | 'error';
}

const AUDIO_STALE_AFTER_MS = 15_000;
const DECISION_FRESH_MS = 30_000;

/**
 * Audio health must never be inferred from the LIVE video badge, a cached
 * candidate, or an FFprobe codec that may predate camera reconfiguration.
 */
export function describeKwsCaptureHealth(
  audio: CctvAudioStatus | null,
  backendReachable: boolean,
  now = Date.now(),
): KwsCaptureHealth {
  if (!backendReachable || !audio) {
    return { state: 'backend-offline', message: 'Camera audio service unavailable', severity: 'error' };
  }
  if (audio.has_audio_track === false) {
    return { state: 'no-track', message: 'No RTSP microphone track', severity: 'error' };
  }
  if (!audio.thread_running || !audio.connected) {
    return {
      state: 'disconnected',
      message: audio.thread_running ? 'Camera microphone disconnected' : 'Audio worker stopped',
      severity: 'error',
    };
  }
  if (!audio.bytes_received || !audio.last_chunk_at) {
    return { state: 'warming-up', message: 'Waiting for decoded microphone samples', severity: 'wait' };
  }
  const last = Date.parse(audio.last_chunk_at);
  if (Number.isFinite(last) && now >= last && now - last > AUDIO_STALE_AFTER_MS) {
    return { state: 'stalled', message: 'Camera audio stalled — check RTSP/FFmpeg', severity: 'error' };
  }
  return { state: 'streaming', message: 'Camera microphone receiving audio', severity: 'ok' };
}

/**
 * Only label a keyword as current when a fresh decision and live audio agree.
 * The backend intentionally retains the most recent decision after speech
 * ends, and may retain it across a temporary RTSP connection loss.
 */
export function recentKwsDecision(
  audio: CctvAudioStatus | null,
  backendReachable: boolean,
  now = Date.now(),
): boolean {
  if (describeKwsCaptureHealth(audio, backendReachable, now).state !== 'streaming') return false;
  const timestamp = audio?.custom_kws?.last_segment_at;
  if (!timestamp) return false;
  const at = Date.parse(timestamp);
  return Number.isFinite(at) && at <= now + 5_000 && now - at < DECISION_FRESH_MS;
}

/**
 * Read-only explanation; never relaxes the KWS classifier's duration veto.
 * Bounds intentionally mirror the existing backend 0.60..1.55 rule.
 */
export function explainKwsDuration(reason?: string | null, ratio?: number | null): string {
  if (reason !== 'duration_mismatch') return '';
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0) {
    return 'The captured word length differs from the enrolled examples.';
  }
  if (ratio < 0.60) {
    return 'The segment is too short versus enrollment; the start of the word may be missing.';
  }
  if (ratio > 1.55) {
    return 'The segment is too long versus enrollment; background noise or speech may have been included.';
  }
  return 'The duration gate rejected this segment; inspect enrollment and the precise backend result.';
}
