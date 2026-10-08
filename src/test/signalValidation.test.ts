import { describe, expect, it } from 'vitest';
import { validateFusionCycle } from '@/lib/signalValidation';

describe('multimodal validation layer', () => {
  it('keeps processing when poor lighting is compensated by usable audio', () => {
    const result = validateFusionCycle({
      visibility: 10,
      audioConnected: true,
      audioReady: true,
      objectScore: 0,
      latencyMs: 100,
    });
    expect(result.ready).toBe(true);
    expect(result.visualUsable).toBe(false);
    expect(result.audioUsable).toBe(true);
    expect(result.flags).toContain('low-light');
  });

  it('fails closed when visual and audio evidence are both unavailable', () => {
    const result = validateFusionCycle({
      visibility: 5,
      audioConnected: false,
      audioReady: false,
      objectScore: 0,
    });
    expect(result.ready).toBe(false);
    expect(result.flags).toContain('low-light');
    expect(result.flags).toContain('audio-unavailable');
  });

  it('allows semantic object evidence to keep a degraded cycle observable', () => {
    const result = validateFusionCycle({
      visibility: 5,
      audioConnected: false,
      objectScore: 75,
    });
    expect(result.ready).toBe(true);
    expect(result.objectUsable).toBe(true);
  });

  it('marks high processing latency for robustness reporting', () => {
    expect(validateFusionCycle({ latencyMs: 1800 }).flags).toContain('high-latency');
  });
});
