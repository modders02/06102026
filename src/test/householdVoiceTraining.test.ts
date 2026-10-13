import { describe, expect, it, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));

import {
  voiceKey, validVoiceWords, pcmWavFromAudio,
} from '@/lib/householdVoiceTraining';

describe('household voice-trained wake words', () => {
  it('keeps English phrase spelling consistent with the local KWS engine', () => {
    expect(voiceKey('Help Me')).toBe('help_me');
    expect(voiceKey('Stay Safe')).toBe('stay_safe');
    expect(voiceKey('911')).toBeNull();
    expect(voiceKey('tulong!')).toBeNull();
    expect(voiceKey('../unsafe')).toBeNull();
  });

  it('filters duplicate, invalid and reserved phrases before activating a profile', () => {
    expect(validVoiceWords([
      { id: 'a', phrase: 'Help Me' },
      { id: 'b', phrase: 'help me' },
      { id: 'c', phrase: '911' },
      { id: 'd', phrase: 'unknown' },
      { id: 'e', phrase: 'Stay Safe' },
    ])).toEqual([
      { id: 'a', phrase: 'Help Me' },
      { id: 'e', phrase: 'Stay Safe' },
    ]);
  });

  it('encodes a short speech-like segment as mono 16 kHz PCM WAV', async () => {
    const rate = 48000;
    const duration = .7;
    const samples = new Float32Array(rate * duration);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = .3 * Math.sin(2 * Math.PI * 400 * i / rate);
    }
    const buffer = {
      length: samples.length, sampleRate: rate, numberOfChannels: 1,
      getChannelData: () => samples,
    } as unknown as AudioBuffer;
    const wav = pcmWavFromAudio(buffer);
    expect(wav.type).toBe('audio/wav');
    const binary = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(wav);
    });
    const bytes = new DataView(binary);
    expect(bytes.getUint32(24, true)).toBe(16000);
    expect(bytes.getUint16(22, true)).toBe(1);
    expect(bytes.getUint16(34, true)).toBe(16);
    expect(wav.size).toBeGreaterThan(0.3 * 16000 * 2);
  });
});
