import { describe, expect, it } from 'vitest';
import { normalizedFace68, personFaceSearchRegion, normalizeDetectedFace } from '@/lib/faceLandmarkFallback';
import { FACE_68_CONNECTIONS, containedVideoRect, faceLandmarkBounds } from '@/lib/landmarkRendering';

describe('on-demand face-api 68 point fallback', () => {
  it('maps input video pixel coordinates to normalized overlay positions', () => {
    const positions = Array.from({ length: 68 }, (_, index) => ({
      x: 300 + (index % 12) * 10,
      y: 240 + Math.floor(index / 12) * 11,
    }));
    const face = normalizedFace68(positions, 1920, 1080);
    expect(face).toHaveLength(68);
    expect(face?.[0].x).toBeCloseTo(300 / 1920);
    expect(face?.[0].y).toBeCloseTo(240 / 1080);
    expect(FACE_68_CONNECTIONS.length).toBeGreaterThan(50);
    const rect = containedVideoRect(960, 540, 1920, 1080);
    expect(faceLandmarkBounds(face!, rect)).not.toBeNull();
  });
  it('accepts actual small distant-face landmarks instead of discarding faces under 3.5% width', () => {
    // A real 24x19 px face in a 1920x1080 source used to be rejected by
    // the tracing size gate despite a valid 68-point facial contour.
    const points = Array.from({ length: 68 }, (_, index) => ({
      x: 650 + (index % 12) * 2.0,
      y: 250 + Math.floor(index / 12) * 3.5,
    }));
    const result = normalizedFace68(points, 1920, 1080);
    expect(result).toHaveLength(68);
    expect(faceLandmarkBounds(result!, containedVideoRect(960, 540, 1920, 1080))).not.toBeNull();
  });

  it('searches within the upper part of a detected person without treating that person box as a face', () => {
    const roi = personFaceSearchRegion({ x: 0.4, y: 0.3, width: 0.2, height: 0.5 });
    expect(roi).not.toBeNull();
    expect(roi!.x).toBeLessThan(0.4);
    expect(roi!.y).toBeLessThan(0.3);
    expect(roi!.height).toBeLessThan(0.5);
    expect(personFaceSearchRegion({ x: 0.4, y: 0.3, width: 0, height: 0.5 })).toBeNull();
    expect(personFaceSearchRegion({ x: NaN, y: 0.3, width: 0.2, height: 0.5 })).toBeNull();
  });

  it('maps a confidence-qualified detector face box from crop pixels back onto the actual video', () => {
    const roi = personFaceSearchRegion({ x: 0.4, y: 0.3, width: 0.2, height: 0.5 })!;
    const found = normalizeDetectedFace({
      detection: {
        score: 0.91,
        box: { x: 40, y: 48, width: 55, height: 60 },
      },
    }, 1920, 1080, roi, 'person ROI');
    expect(found?.landmarks).toBeNull();
    expect(found?.source).toBe('face-api box');
    expect(found?.search).toBe('person ROI');
    expect(found?.box.x).toBeCloseTo(roi.x + 40 / 1920);
    expect(found?.box.y).toBeCloseTo(roi.y + 48 / 1080);
    expect(found?.box.width).toBeCloseTo(55 / 1920);
    expect(found?.box.height).toBeCloseTo(60 / 1080);
  });

  it('never turns a person bbox or a weak/degenerate face detector response into a face box', () => {
    const box = { x: 100, y: 80, width: 80, height: 85 };
    expect(normalizeDetectedFace({
      detection: { score: 0.55, box },
    }, 1920, 1080)).toBeNull();
    expect(normalizeDetectedFace({
      detection: { score: 0.95, box: { ...box, width: 0 } },
    }, 1920, 1080)).toBeNull();
    expect(normalizeDetectedFace(null, 1920, 1080)).toBeNull();
  });

  it('refuses invalid video dimensions and a non-face landmark set', () => {
    const pts = Array.from({ length: 68 }, () => ({ x: 40, y: 30 }));
    expect(normalizedFace68(pts, 0, 1080)).toBeNull();
    expect(normalizedFace68(pts.slice(0, 4), 640, 360)).toBeNull();
    expect(normalizedFace68(pts, 640, 360)).toBeNull();
  });
});
