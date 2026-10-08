export type ValidationFlag =
  | 'low-light'
  | 'audio-unavailable'
  | 'audio-not-ready'
  | 'high-latency';

export interface FusionValidationInput {
  visibility?: number;
  audioConnected?: boolean;
  audioReady?: boolean;
  objectScore?: number;
  latencyMs?: number;
}

export interface FusionValidationResult {
  ready: boolean;
  visualUsable: boolean;
  audioUsable: boolean;
  objectUsable: boolean;
  flags: ValidationFlag[];
}

/**
 * Lightweight validation layer before alert evaluation. It does not fabricate
 * missing evidence: it records which modalities are trustworthy so degraded
 * lighting/noise/transport conditions cannot silently look like normal input.
 */
export function validateFusionCycle(input: FusionValidationInput): FusionValidationResult {
  const flags: ValidationFlag[] = [];
  const visibility = Number.isFinite(input.visibility) ? Number(input.visibility) : 100;
  const visualUsable = visibility >= 20;
  if (!visualUsable) flags.push('low-light');

  // Unknown/not-yet-polled audio is not evidence. Require an explicit backend
  // connection before the audio modality can validate a degraded visual cycle.
  const audioConnected = input.audioConnected === true;
  const audioReady = input.audioReady !== false;
  const audioUsable = audioConnected && audioReady;
  if (!audioConnected) flags.push('audio-unavailable');
  else if (!audioReady) flags.push('audio-not-ready');

  const objectUsable = (input.objectScore ?? 0) > 0;
  if ((input.latencyMs ?? 0) > 1500) flags.push('high-latency');

  return {
    ready: visualUsable || audioUsable || objectUsable,
    visualUsable,
    audioUsable,
    objectUsable,
    flags,
  };
}
