export const FIRE_FUSION_WINDOW_MS = 10_000;
export const SMOKE_REGION_MIN_RATIO = 0.18;
export const FIRE_LOW_VISIBILITY = 45;

export interface FireVisualSignal {
  confidence: number;
  at: number;
  firePixelRatio: number;
  smokeRatio: number;
  visibility: number;
}

export interface SunogSignal {
  confidence: number;
  at: number;
  phrase: 'sunog';
}

export interface VerifiedFireSpeech {
  fire: FireVisualSignal;
  speech: SunogSignal;
  confidence: number;
  at: number;
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

/**
 * A visual fire candidate is deliberately looser than a standalone fire alarm.
 * Small flame/color regions may participate because speech or smoke provides
 * the second independent signal.
 */
export function makeFireVisualSignal(
  candidate: boolean,
  confidence: number,
  firePixelRatio = 0,
  smokeRatio = 0,
  visibility = 100,
  at = Date.now(),
): FireVisualSignal | null {
  if (!candidate) return null;
  const candidateConfidence = Math.max(
    0.35,
    clamp01(Math.max(confidence, firePixelRatio > 0 ? 0.35 + firePixelRatio * 20 : 0)),
  );
  return {
    confidence: candidateConfidence,
    at,
    firePixelRatio: Math.max(0, firePixelRatio || 0),
    smokeRatio: Math.max(0, smokeRatio || 0),
    visibility: Number.isFinite(visibility) ? visibility : 100,
  };
}

/** Reserve only the explicit Tagalog fire keyword family for visual verification. */
export function makeSunogSignal(
  transcript: string | null | undefined,
  confidence = 1,
  at = Date.now(),
): SunogSignal | null {
  const normalized = (transcript ?? '')
    .toLocaleLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z]+/g, ' ')
    .trim();

  // Covers "sunog", "may sunog", "amoy sunog", Whisper's common "sonog",
  // and "nasusunog" while avoiding unrelated fire vocabulary such as "usok".
  const matched =
    /(^| )sunog( |$)/.test(normalized)
    || /(^| )sonog( |$)/.test(normalized)
    || /(^| )nasusunog( |$)/.test(normalized);

  if (!matched) return null;
  return { phrase: 'sunog', confidence: clamp01(confidence), at };
}

export function fuseFireWithSunog(
  fire: FireVisualSignal | null | undefined,
  speech: SunogSignal | null | undefined,
  windowMs = FIRE_FUSION_WINDOW_MS,
): VerifiedFireSpeech | null {
  if (!fire || !speech || Math.abs(fire.at - speech.at) > windowMs) return null;
  return {
    fire,
    speech,
    confidence: Math.min(fire.confidence, speech.confidence),
    at: Math.max(fire.at, speech.at),
  };
}

/**
 * Vision-only corroboration requested by the fire rule:
 * any visual fire candidate plus either a meaningful smoke region or low
 * visibility is immediately treated as a verified fire condition.
 */
export function isImmediateFireSmoke(
  fire: FireVisualSignal | null | undefined,
): boolean {
  return !!fire && (
    fire.smokeRatio >= SMOKE_REGION_MIN_RATIO
    || fire.visibility <= FIRE_LOW_VISIBILITY
  );
}

export function fireSpeechLabel() {
  return 'Verified fire: visual fire + "sunog"';
}

export function fireSmokeLabel(fire: FireVisualSignal) {
  const smokePercent = Math.round(fire.smokeRatio * 100);
  if (fire.smokeRatio >= SMOKE_REGION_MIN_RATIO && fire.visibility <= FIRE_LOW_VISIBILITY) {
    return `Verified fire: fire + smoke (${smokePercent}%) + low visibility`;
  }
  if (fire.smokeRatio >= SMOKE_REGION_MIN_RATIO) {
    return `Verified fire: fire + smoke region (${smokePercent}%)`;
  }
  return `Verified fire: fire + low visibility (${Math.round(fire.visibility)}/100)`;
}
