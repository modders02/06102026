/** Observable facial MOVEMENT cues inferred from MediaPipe's blendshapes.
 *
 * This is a deterministic, uncalibrated visualization heuristic, NOT an
 * emotion/mood classifier, mental-health diagnosis, distress validator,
 * biometric identity, or a new emergency-alert signal.
 *
 * Blendshape coefficients in [0,1] describe estimated muscle motions.
 * Their values must never be displayed as P(happy) / P(fearful).
 */
export interface FacialBlendshapeCategory {
  categoryName: string;
  score: number;
}

export type FacialMovementKind =
  | 'smile' | 'mouth-open' | 'eyes-wide' | 'brow-raised'
  | 'brow-furrowed' | 'lip-corners-down' | 'neutral';

export interface FacialMovementObservation {
  kind: FacialMovementKind;
  label: string;
  /** Activation strength, NOT class probability. */
  activation: number;
  features: readonly string[];
  source: 'mediapipe-blendshapes';
}

/** Explicitly invalid/no-face data results in null, never "neutral". */
export function classifyFacialMovement(
  categories: readonly FacialBlendshapeCategory[] | null | undefined,
): FacialMovementObservation | null {
  if (!categories?.length) return null;
  const data = new Map<string, number>();
  for (const item of categories) {
    if (!item || typeof item.categoryName !== 'string'
        || !Number.isFinite(item.score) || item.score < 0 || item.score > 1) continue;
    data.set(item.categoryName, item.score);
  }

  const pair = (a: string, b: string): number | null => {
    const left = data.get(a), right = data.get(b);
    if (left === undefined || right === undefined) return null;
    return (left + right) / 2;
  };
  const one = (name: string) => data.get(name) ?? null;
  const candidates: Omit<FacialMovementObservation, 'source'>[] = [];
  const offer = (
    kind: Exclude<FacialMovementKind, 'neutral'>, label: string,
    value: number | null, cutoff: number, features: readonly string[],
  ) => {
    if (value !== null && value >= cutoff) {
      candidates.push({ kind, label, activation: value, features });
    }
  };

  // Bilateral muscle cues reduce false readings from pose, occlusion
  // or a single distorted eyebrow / lip corner in an angled CCTV view.
  offer('smile', 'Smiling', pair('mouthSmileLeft', 'mouthSmileRight'), 0.45,
    ['mouthSmileLeft', 'mouthSmileRight']);
  offer('mouth-open', 'Mouth open', one('jawOpen'), 0.58, ['jawOpen']);
  offer('eyes-wide', 'Eyes widened', pair('eyeWideLeft', 'eyeWideRight'), 0.48,
    ['eyeWideLeft', 'eyeWideRight']);
  offer('brow-raised', 'Brows raised', one('browInnerUp'), 0.57, ['browInnerUp']);
  offer('brow-furrowed', 'Brows lowered', pair('browDownLeft', 'browDownRight'), 0.55,
    ['browDownLeft', 'browDownRight']);
  offer('lip-corners-down', 'Lip corners lowered',
    pair('mouthFrownLeft', 'mouthFrownRight'), 0.52,
    ['mouthFrownLeft', 'mouthFrownRight']);

  // Require a recognizable subset of a complete 52-blendshape response.
  // An incomplete list should NEVER create a "neutral" assertion.
  const valid = ['jawOpen', 'mouthSmileLeft', 'mouthSmileRight', 'eyeWideLeft',
    'eyeWideRight', 'browDownLeft', 'browDownRight'];
  if (valid.some(name => !data.has(name))) return null;

  candidates.sort((a, b) => b.activation - a.activation);
  const chosen = candidates[0];
  return chosen
    ? { ...chosen, source: 'mediapipe-blendshapes' }
    : { kind: 'neutral', label: 'No dominant facial movement', activation: 0,
        features: [], source: 'mediapipe-blendshapes' };
}

/** Suppress one-frame label flips while remaining responsive to a deliberate
 * facial expression change. Discard all history when there is no face.
 */
export function stableFacialMovement(
  history: readonly FacialMovementObservation[],
  next: FacialMovementObservation | null, windowSize = 3,
): { history: FacialMovementObservation[]; displayed: FacialMovementObservation | null } {
  if (!next) return { history: [], displayed: null };
  const size = Math.max(1, Math.min(5, Math.trunc(windowSize) || 3));
  const current = [...history.slice(-(size - 1)), next].slice(-size);
  const votes = new Map<FacialMovementKind, { count: number; sample: FacialMovementObservation }>();
  for (const observation of current) {
    const prev = votes.get(observation.kind);
    votes.set(observation.kind, {
      count: (prev?.count ?? 0) + 1,
      sample: observation,
    });
  }
  const winner = [...votes.values()].sort((a, b) => b.count - a.count)[0];
  const minVotes = size > 1 ? 2 : 1;
  return { history: current,
    displayed: winner && winner.count >= minVotes ? winner.sample : null };
}
