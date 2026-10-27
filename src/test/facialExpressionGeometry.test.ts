import { describe, expect, it } from 'vitest';
import { estimateHistoryExpression, measureExpressionGeometry } from '@/lib/facialExpressionGeometry';

function landmarkFrame(mouthGap: number, eyeGap: number, browGap: number) {
  const points = Array.from({ length: 68 }, () => ({ x: 50, y: 50 }));
  // Mouth width 40, eye width 20. The ratios are independent of image size.
  points[48] = { x: 35, y: 77 };
  points[54] = { x: 75, y: 77 };
  points[62] = { x: 55, y: 77 - mouthGap / 2 };
  points[66] = { x: 55, y: 77 + mouthGap / 2 };
  points[36] = { x: 30, y: 36 };
  points[39] = { x: 50, y: 36 };
  points[37] = { x: 40, y: 36 - eyeGap / 2 };
  points[41] = { x: 40, y: 36 + eyeGap / 2 };
  points[42] = { x: 60, y: 36 };
  points[45] = { x: 80, y: 36 };
  points[43] = { x: 70, y: 36 - eyeGap / 2 };
  points[47] = { x: 70, y: 36 + eyeGap / 2 };
  points[19] = { x: 40, y: points[37].y - browGap };
  points[24] = { x: 70, y: points[43].y - browGap };
  return points;
}

describe('display-only expression geometry', () => {
  it('corrects a likely frightened open-mouth face despite high raw Sad score', () => {
    const landmarks = measureExpressionGeometry(landmarkFrame(16, 6, 11));
    expect(landmarks).toMatchObject({
      mouthOpening: 0.4, eyeOpening: 0.3, browElevation: 0.55,
    });
    const display = estimateHistoryExpression({
      sad: 0.99, fearful: 0.003, happy: 0.001, neutral: 0.006,
    }, landmarks);
    expect(display.label).toBe('fearful');
    expect(display.geometryCorrected).toBe(true);
    expect(display.confidence).toBeGreaterThanOrEqual(0.55);
    expect(display.confidence).toBeLessThan(0.8);
  });

  it('retains Sad for an ordinary closed-mouth face', () => {
    const geometry = measureExpressionGeometry(landmarkFrame(3, 3, 4));
    expect(estimateHistoryExpression({ sad: 0.99 }, geometry)).toMatchObject({
      label: 'sad', confidence: 0.99, geometryCorrected: false,
    });
  });

  it('does not override a confident smile or a surprised class', () => {
    const geometry = measureExpressionGeometry(landmarkFrame(16, 6, 11));
    expect(estimateHistoryExpression({ happy: 0.92, sad: 0.08 }, geometry).label).toBe('happy');
    expect(estimateHistoryExpression({ surprised: 0.89, sad: 0.11 }, geometry).label).toBe('surprised');
  });

  it('gracefully falls back when landmarks are missing or malformed', () => {
    expect(measureExpressionGeometry(undefined)).toBeNull();
    expect(measureExpressionGeometry([{ x: NaN, y: 5 }])).toBeNull();
    expect(estimateHistoryExpression({ sad: 0.99 }, null).label).toBe('sad');
  });
});
