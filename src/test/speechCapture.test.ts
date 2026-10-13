import { describe, expect, it } from 'vitest';
import { SpeechCaptureGate } from '@/lib/speechCapture';

describe('automatic household enrollment speech capture', () => {
  it('captures a complete utterance once it hears sustained voice followed by silence', () => {
    const gate = new SpeechCaptureGate();
    expect(gate.update(0.004, 0)).toBe('waiting');
    expect(gate.update(0.005, 100)).toBe('waiting');
    expect(gate.update(0.11, 200)).toBe('waiting');
    expect(gate.update(0.10, 360)).toBe('speaking');
    expect(gate.update(0.08, 480)).toBe('speaking');
    expect(gate.update(0.06, 680)).toBe('speaking');
    expect(gate.update(0.005, 740)).toBe('speaking');
    expect(gate.update(0.003, 1140)).toBe('captured');
    expect(gate.update(0.1, 1200)).toBe('captured');
  });

  it('rejects an isolated noise spike instead of saving it', () => {
    const gate = new SpeechCaptureGate();
    gate.update(0.11, 100);
    expect(gate.update(0.002, 140)).toBe('waiting');
    expect(gate.update(0.002, 7100)).toBe('timeout');
  });

  it('rejects a very short noise-like utterance', () => {
    const gate = new SpeechCaptureGate();
    gate.update(0.1, 100);
    gate.update(0.1, 240);
    gate.update(0.1, 280);
    gate.update(0.003, 320);
    expect(gate.update(0.003, 760)).toBe('too_short');
  });

  it('rejects long speech and keeps the microphone from recording indefinitely', () => {
    const gate = new SpeechCaptureGate();
    gate.update(0.1, 100);
    gate.update(0.1, 230);
    gate.update(0.1, 500);
    expect(gate.update(0.1, 3000)).toBe('too_long');
  });

  it('waits for genuine voice above room noise instead of triggering from low-level hum', () => {
    const gate = new SpeechCaptureGate();
    for (let ms = 0; ms < 7000; ms += 100) expect(gate.update(0.012, ms)).toBe('waiting');
    expect(gate.update(0.012, 7200)).toBe('timeout');
  });
});
