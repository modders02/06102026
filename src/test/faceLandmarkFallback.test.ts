import { describe, expect, it } from 'vitest';
import { normalizedFace68 } from '@/lib/faceLandmarkFallback';
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
  it('refuses invalid video dimensions and a non-face landmark set', () => {
    const pts = Array.from({ length: 68 }, () => ({ x: 40, y: 30 }));
    expect(normalizedFace68(pts, 0, 1080)).toBeNull();
    expect(normalizedFace68(pts.slice(0, 4), 640, 360)).toBeNull();
    expect(normalizedFace68(pts, 640, 360)).toBeNull();
  });
});
