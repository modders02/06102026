export const MULTIMODAL_FUSION_WINDOW_MS = 4_000;
export const DISTRESS_FACE_MIN_CONFIDENCE = 0.55;
export const DISTRESS_FACE_FRESHNESS_MS = 2500;

export type DistressFaceLabel = 'Angry' | 'Frightened';
export type DistressKeyword = 'help';

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

export function normalizeDistressFaceLabel(
  expression: string | null | undefined,
): DistressFaceLabel | null {
  const normalized = (expression ?? '').trim().toLowerCase();
  if (normalized === 'angry' || normalized === 'anger') return 'Angry';
  if (
    normalized === 'fearful' || normalized === 'fear' || normalized === 'frightened'
    || normalized === 'surprised' || normalized === 'surprise'
    || normalized === 'shock' || normalized === 'shocked'
  ) return 'Frightened';
  return null;
}

export function isMultimodalDistressExpression(expression: string | null | undefined) {
  return normalizeDistressFaceLabel(expression) !== null;
}

export function makeDistressFaceSignal(
  expression: string | null | undefined,
  confidence: number,
  at = Date.now(),
): DistressFaceSignal | null {
  if (!Number.isFinite(confidence) || confidence < DISTRESS_FACE_MIN_CONFIDENCE) return null;
  const label = normalizeDistressFaceLabel(expression);
  return label ? { label, confidence, at } : null;
}

/**
 * Distress fusion is intentionally strict: only the accepted word "help"
 * can combine with an Angry/Frightened face to create a distress alert.
 */
export function makeDistressSpeechSignal(
  transcript: string | null | undefined,
  confidence = 1,
  at = Date.now(),
): DistressSpeechSignal | null {
  const text = (transcript ?? '').toLowerCase();
  if (!/(^|[^a-z])help([^a-z]|$)/i.test(text)) return null;
  const keyword: DistressKeyword = 'help';
  return {
    keyword,
    transcript: (transcript ?? '').trim(),
    confidence: Math.max(0, Math.min(1, Number.isFinite(confidence) ? confidence : 0)),
    at,
  };
}

export function makeDistressSoundSignal(
  _sound: string | null | undefined,
  _confidence = 1,
  _at = Date.now(),
): DistressSpeechSignal | null {
  // Sound-only cues such as screaming are diagnostic only. They do not satisfy
  // the distress alert fusion rule without the accepted spoken word "help".
  return null;
}

export function fuseDistressSignals(
  face: DistressFaceSignal | null | undefined,
  speech: DistressSpeechSignal | null | undefined,
  windowMs = MULTIMODAL_FUSION_WINDOW_MS,
): VerifiedMultimodalDistress | null {
  if (!face || !speech || Math.abs(face.at - speech.at) > windowMs) return null;

  const compatible =
    speech.keyword === 'help'
    && (face.label === 'Angry' || face.label === 'Frightened');

  if (!compatible) return null;

  return {
    face,
    speech,
    confidence: Math.min(face.confidence, speech.confidence),
    at: Math.max(face.at, speech.at),
  };
}

export function multimodalDistressLabel(result: VerifiedMultimodalDistress) {
  return `Verified distress: ${result.face.label} + "help"`;
}
