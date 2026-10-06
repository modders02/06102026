export const MULTIMODAL_FUSION_WINDOW_MS = 10_000;
export const DISTRESS_FACE_MIN_CONFIDENCE = 0.55;

export type DistressFaceLabel = 'Angry' | 'Frightened';
export type DistressKeyword = 'help' | 'tulong';

export interface DistressFaceSignal {
  label: DistressFaceLabel;
  confidence: number;
  at: number;
}

export interface DistressSpeechSignal {
  keyword: DistressKeyword;
  transcript: string;
  confidence: number;
  at: number;
}

export interface VerifiedMultimodalDistress {
  face: DistressFaceSignal;
  speech: DistressSpeechSignal;
  confidence: number;
  at: number;
}

export function makeDistressFaceSignal(
  expression: string | null | undefined,
  confidence: number,
  at = Date.now(),
): DistressFaceSignal | null {
  if (!Number.isFinite(confidence) || confidence < DISTRESS_FACE_MIN_CONFIDENCE) return null;
  const normalized = (expression ?? '').trim().toLowerCase();
  if (normalized === 'angry' || normalized === 'anger') {
    return { label: 'Angry', confidence, at };
  }
  if (normalized === 'fearful' || normalized === 'fear' || normalized === 'frightened') {
    return { label: 'Frightened', confidence, at };
  }
  return null;
}

/**
 * Only the explicit fusion words requested by the safety rule qualify.
 * Other safety phrases continue through their existing alert logic.
 */
export function makeDistressSpeechSignal(
  transcript: string | null | undefined,
  confidence = 1,
  at = Date.now(),
): DistressSpeechSignal | null {
  const text = (transcript ?? '').toLowerCase();
  const keyword: DistressKeyword | null =
    /(^|[^a-z])help([^a-z]|$)/i.test(text) ? 'help'
      : /(^|[^a-z])tulong([^a-z]|$)/i.test(text) ? 'tulong'
        : null;
  if (!keyword) return null;
  return {
    keyword,
    transcript: (transcript ?? '').trim(),
    confidence: Math.max(0, Math.min(1, Number.isFinite(confidence) ? confidence : 0)),
    at,
  };
}

export function fuseDistressSignals(
  face: DistressFaceSignal | null | undefined,
  speech: DistressSpeechSignal | null | undefined,
  windowMs = MULTIMODAL_FUSION_WINDOW_MS,
): VerifiedMultimodalDistress | null {
  if (!face || !speech || Math.abs(face.at - speech.at) > windowMs) return null;
  return {
    face,
    speech,
    confidence: Math.min(face.confidence, speech.confidence),
    at: Math.max(face.at, speech.at),
  };
}

export function multimodalDistressLabel(result: VerifiedMultimodalDistress) {
  return `Verified distress: ${result.face.label} + "${result.speech.keyword}"`;
}
