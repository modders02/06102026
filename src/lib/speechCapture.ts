/**
 * A short-utterance voice activity gate for microphone enrollment.
 *
 * The gate detects the *beginning and end of speech-like audio*, not the
 * linguistic identity of a previously untrained phrase. An enrollment is only
 * saved if a complete bounded utterance was captured and passes WAV checks.
 */
export type CaptureState = 'waiting' | 'speaking' | 'captured' | 'timeout' | 'too_short' | 'too_long';

const START_LEVEL = 0.028;
const CONTINUE_LEVEL = 0.016;
const VOICE_ONSET_MS = 120;
const END_SILENCE_MS = 360;
const MIN_UTTERANCE_MS = 300;
const MAX_UTTERANCE_MS = 2500;
const MAX_WAIT_MS = 7000;

export class SpeechCaptureGate {
  private state: CaptureState = 'waiting';
  private noiseFloor = 0.006;
  private onsetAt: number | null = null;
  private startedAt: number | null = null;
  private lastVoiceAt: number | null = null;
  private silenceAt: number | null = null;
  private voiceDurationMs = 0;
  private lastUpdateAt: number | null = null;

  update(rms: number, elapsedMs: number): CaptureState {
    if (['captured', 'timeout', 'too_short', 'too_long'].includes(this.state)) return this.state;
    const amplitude = Number.isFinite(rms) ? Math.max(0, rms) : 0;
    const now = Math.max(0, elapsedMs);
    const startThreshold = Math.max(START_LEVEL, this.noiseFloor * 3.2);
    const continueThreshold = Math.max(CONTINUE_LEVEL, this.noiseFloor * 2.0);

    if (this.state === 'waiting') {
      if (amplitude >= startThreshold) {
        if (this.onsetAt === null) this.onsetAt = now;
        if (now - this.onsetAt >= VOICE_ONSET_MS) {
          this.state = 'speaking';
          this.startedAt = this.onsetAt;
          this.lastVoiceAt = now;
          this.lastUpdateAt = now;
        }
      } else {
        this.onsetAt = null;
        if (amplitude < START_LEVEL) {
          this.noiseFloor = this.noiseFloor * 0.95 + amplitude * 0.05;
        }
      }
      if (now >= MAX_WAIT_MS && this.state === 'waiting') this.state = 'timeout';
      return this.state;
    }

    if (this.startedAt !== null && now - this.startedAt > MAX_UTTERANCE_MS + END_SILENCE_MS) {
      this.state = 'too_long';
      return this.state;
    }
    const voiced = amplitude >= continueThreshold;
    if (voiced) {
      this.voiceDurationMs += this.lastUpdateAt === null ? 0 : Math.max(0, now - this.lastUpdateAt);
      this.lastVoiceAt = now;
      this.silenceAt = null;
    } else if (this.silenceAt === null) {
      this.silenceAt = now;
    }
    this.lastUpdateAt = now;

    if (this.silenceAt !== null && now - this.silenceAt >= END_SILENCE_MS) {
      const duration = (this.lastVoiceAt ?? now) - (this.startedAt ?? now);
      this.state = duration >= MIN_UTTERANCE_MS && this.voiceDurationMs >= MIN_UTTERANCE_MS * 0.6
        ? 'captured' : 'too_short';
    }
    return this.state;
  }

  get current(): CaptureState { return this.state; }
}
