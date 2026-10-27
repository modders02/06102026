/** Additional, display-only cues from the 68 face landmarks. They are not
 * biometric recognition, a psychological diagnosis, or emergency evidence.
 * The underlying classifier often calls an alarmed open-mouth face "Sad";
 * require a strong geometric contradiction before correcting that label.
 */
export interface FacialPoint { x: number; y: number }
export interface ExpressionGeometry {
  mouthOpening: number;
  eyeOpening: number;
  browElevation: number;
}
const distance = (a: FacialPoint, b: FacialPoint) => Math.hypot(a.x - b.x, a.y - b.y);
const safeRatio = (numerator: number, denominator: number) =>
  denominator > 1e-5 ? numerator / denominator : 0;

export function measureExpressionGeometry(
  points?: readonly FacialPoint[],
): ExpressionGeometry | null {
  if (!points || points.length < 68
      || points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;
  const width = distance(points[48], points[54]);
  const leftEyeWidth = distance(points[36], points[39]);
  const rightEyeWidth = distance(points[42], points[45]);
  if (width < 1e-4 || leftEyeWidth < 1e-4 || rightEyeWidth < 1e-4) return null;
  const mouthOpening = safeRatio(distance(points[62], points[66]), width);
  const leftEye = safeRatio(distance(points[37], points[41]), leftEyeWidth);
  const rightEye = safeRatio(distance(points[43], points[47]), rightEyeWidth);
  const leftBrow = safeRatio(distance(points[19], points[37]), leftEyeWidth);
  const rightBrow = safeRatio(distance(points[24], points[44]), rightEyeWidth);
  return {
    mouthOpening,
    eyeOpening: (leftEye + rightEye) / 2,
    browElevation: (leftBrow + rightBrow) / 2,
  };
}

export interface HistoryExpressionEstimate {
  label: string;
  confidence: number;
  /** True when geometric evidence contradicts an extreme Sad prediction. */
  geometryCorrected: boolean;
}

/** Conservative override of a likely misclassified startled/fright-like face.
 * Geometry alone is ambiguous: this estimate MUST NOT be used for fusion,
 * Camera Alerts, KWS validation, or safety decisions.
 */
export function estimateHistoryExpression(
  probabilities: Readonly<Record<string, number>>,
  geometry: ExpressionGeometry | null,
): HistoryExpressionEstimate {
  let label = 'neutral';
  let confidence = 0;
  for (const [name, value] of Object.entries(probabilities)) {
    if (Number.isFinite(value) && value > confidence && value <= 1) {
      label = name;
      confidence = value;
    }
  }
  const looksAlarmed = !!geometry
    && geometry.mouthOpening >= 0.28
    && geometry.eyeOpening >= 0.18
    && geometry.browElevation >= 0.38;
  // Apply ONLY to likely false Sad: open mouth, raised brows, open eyes.
  // Uncertain result gets a modest evidence score, not the 99% Sad score.
  if (label === 'sad' && confidence >= 0.65 && looksAlarmed
      && (probabilities.happy ?? 0) < 0.2) {
    return {
      label: 'fearful',
      confidence: Math.min(0.75, 0.58
        + Math.min(0.1, Math.max(0, geometry!.mouthOpening - 0.28) * 0.35)
        + Math.min(0.07, Math.max(0, geometry!.browElevation - 0.38) * 0.22)),
      geometryCorrected: true,
    };
  }
  return { label, confidence, geometryCorrected: false };
}
