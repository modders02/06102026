/** Five seconds for face validation after KWS acceptance (not history logging). */
export const MULTIMODAL_FUSION_WINDOW_MS = 5_000;
export const DISTRESS_FACE_MIN_CONFIDENCE = 0.55;
export const DISTRESS_FACE_FRESHNESS_MS = 2500;
/**
 * Backends timestamp the audio segment before transcription/KWS completes.
 * Fusion validation starts when an ACCEPTED result reaches this camera, not
 * at the segment's earlier start; otherwise its 4s window can already have
 * expired on arrival. Very old or future-dated results still fail closed.
 */
export const MAX_ACCEPTED_KWS_DELIVERY_LAG_MS = 6_000;
export const MAX_ACCEPTED_KWS_FUTURE_SKEW_MS = 2_000;

export function acceptedDistressReceiptTime(
  segmentTimestamp: string | null | undefined,
  receivedAt = Date.now(),
): number | null {
  const segmentAt = Date.parse(segmentTimestamp ?? '');
  if (!Number.isFinite(segmentAt)) return null;
  const delay = receivedAt - segmentAt;
  if (delay > MAX_ACCEPTED_KWS_DELIVERY_LAG_MS
      || delay < -MAX_ACCEPTED_KWS_FUTURE_SKEW_MS) return null;
  return receivedAt;
}


export type DistressFaceLabel = 'Angry' | 'Frightened' | 'Sad';

/** Application validation rules, not a diagnosis of the expression's cause. */
export const KEYWORD_FACE_PAIRINGS = {
  help: ['Angry', 'Frightened'],
  emergency: ['Frightened'],
  danger: ['Angry', 'Frightened'],
  intruder: ['Angry', 'Frightened'],
  police: ['Angry', 'Frightened'],
  ambulance: ['Sad', 'Frightened'],
} as const satisfies Record<string, readonly DistressFaceLabel[]>;

export type FacialValidationKeyword = keyof typeof KEYWORD_FACE_PAIRINGS;
// Fire keeps its separate detector-confirmed visual validation path.
export type DistressKeyword = FacialValidationKeyword;
const DISTRESS_KEYWORD_PATTERN = new RegExp(
  `(^|[^a-z])(${Object.keys(KEYWORD_FACE_PAIRINGS).join('|')})(?=$|[^a-z])`, 'i',
);

export function facialExpressionsForKeyword(keyword: string): readonly DistressFaceLabel[] {
  const normalized = keyword.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(KEYWORD_FACE_PAIRINGS, normalized)
    ? KEYWORD_FACE_PAIRINGS[normalized as FacialValidationKeyword] : [];
}

export function facialValidationRequirement(keyword: string): string {
  return facialExpressionsForKeyword(keyword).join('/');
}

export function isKeywordFaceCompatible(keyword: string, expression: string | null | undefined) {
  const label = normalizeDistressFaceLabel(expression);
  return !!label && facialExpressionsForKeyword(keyword).includes(label);
}

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
  if (normalized === 'sad' || normalized === 'sadness') return 'Sad';
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
 * Only a configured, accepted keyword can combine with its matching facial
 * expression. Fire is handled separately with detector-confirmed visual fire.
 */
export function makeDistressSpeechSignal(
  transcript: string | null | undefined,
  confidence = 1,
  at = Date.now(),
): DistressSpeechSignal | null {
  const text = (transcript ?? '').toLowerCase();
  const match = DISTRESS_KEYWORD_PATTERN.exec(text);
  if (!match) return null;
  const keyword = match[2] as DistressKeyword;
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
  // the distress alert fusion rule without an accepted configured keyword.
  return null;
}

export function fuseDistressSignals(
  face: DistressFaceSignal | null | undefined,
  speech: DistressSpeechSignal | null | undefined,
  windowMs = MULTIMODAL_FUSION_WINDOW_MS,
): VerifiedMultimodalDistress | null {
  if (!face || !speech || Math.abs(face.at - speech.at) > windowMs) return null;

  const compatible = isKeywordFaceCompatible(speech.keyword, face.label);

  if (!compatible) return null;

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
