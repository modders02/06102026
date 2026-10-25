import { describe, expect, it, vi } from 'vitest';
import { containedVideoRect, toCanvasPoint, drawConnections, drawFaceLandmarkBounds, faceLandmarkBounds, imageLandmarks, usableFaceLandmarks, validLandmarkCount, FACE_68_CONNECTIONS, drawQualityConnections, smoothLandmarks, updateTrail, drawTrail } from '@/lib/landmarkRendering';

describe('video-aligned face / pose / hand tracing geometry', () => {
  it('keeps camera geometry inside the actual object-contain video instead of painting letterboxes', () => {
    const rect = containedVideoRect(800, 600, 1920, 1080);
    expect(rect).toEqual({ x: 0, y: 75, width: 800, height: 450 });
    expect(toCanvasPoint({ x: 0.5, y: 0.5 }, rect)).toEqual({ x: 400, y: 300 });
    expect(toCanvasPoint({ x: 0, y: 0 }, rect)).toEqual({ x: 0, y: 75 });
    expect(toCanvasPoint({ x: -0.1, y: 0.2 }, rect)).toBeNull();
  });
  it('handles invalid camera/video sizes and non-finite model coordinates', () => {
    expect(containedVideoRect(800, 600, 0, 0)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(toCanvasPoint({ x: Number.NaN, y: 0.3 }, containedVideoRect(800, 600, 800, 600))).toBeNull();
  });
  it('ignores occluded points and never draws connections to invalid endpoints', () => {
    const ctx = {
      save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(),
      lineTo: vi.fn(), stroke: vi.fn(), globalAlpha: 1, lineWidth: 1, strokeStyle: '',
    } as unknown as CanvasRenderingContext2D;
    drawConnections(ctx, [
      { x: 0.25, y: 0.25, visibility: 0.2 },
      { x: 0.75, y: 0.75, visibility: 0.95 },
    ], [{ start: 0, end: 1 }], { x: 0, y: 0, width: 320, height: 180 }, '#22d3ee');
    expect(ctx.moveTo).not.toHaveBeenCalled();
    expect(ctx.stroke).toHaveBeenCalledTimes(1);
  });
  it('bounds motion trails, clears lost hands and does not persist identities', () => {
    const trails = new Map();
    const rect = containedVideoRect(500, 500, 500, 500);
    for (let i = 0; i < 40; i++) updateTrail(trails, 'hand-0', { x: i / 40, y: 0.5 }, rect, 12);
    expect(trails.get('hand-0')).toHaveLength(12);
    expect(updateTrail(trails, 'hand-0', undefined, rect)).toEqual([]);
    expect(trails.has('hand-0')).toBe(false);
  });
  it('draws trails without changing alert state', () => {
    const ctx = {
      save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(),
      lineTo: vi.fn(), stroke: vi.fn(), strokeStyle: '', lineWidth: 0,
    } as unknown as CanvasRenderingContext2D;
    drawTrail(ctx, [{ x: 10, y: 20 }, { x: 15, y: 30 }], '#fbbf24');
    expect(ctx.stroke).toHaveBeenCalledOnce();
  });
  it('smooths small frame-to-frame jitter without dragging landmarks after abrupt changes', () => {
    const prev = [{ x: 0.4, y: 0.4, visibility: 0.95 }];
    const smoothed = smoothLandmarks(prev, [{ x: 0.5, y: 0.4, visibility: 0.95 }], 0.5);
    expect(smoothed[0].x).toBeCloseTo(0.45);
    const jumped = smoothLandmarks(smoothed, [{ x: 0.95, y: 0.95, visibility: 0.95 }], 0.5);
    expect(jumped[0]).toMatchObject({ x: 0.95, y: 0.95 });
    const occluded = smoothLandmarks(smoothed, [{ x: 0.46, y: 0.46, visibility: 0.1 }]);
    expect(occluded[0]).toMatchObject({ x: 0.46, y: 0.46 });
    expect(smoothLandmarks(null, prev)).toEqual(prev);
  });
  it('drops body bones that are occluded, off-camera or implausibly long', () => {
    const ctx = {
      save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(),
      lineTo: vi.fn(), stroke: vi.fn(), strokeStyle: '', lineWidth: 0,
      lineJoin: 'miter', lineCap: 'butt', globalAlpha: 1,
    } as unknown as CanvasRenderingContext2D;
    const points = [
      { x: 0.1, y: 0.1, visibility: 0.99, presence: 0.99 },
      { x: 0.2, y: 0.2, visibility: 0.97, presence: 0.97 },
      { x: 0.8, y: 0.8, visibility: 0.97, presence: 0.97 },
      { x: 0.3, y: 0.4, visibility: 0.1, presence: 0.97 },
    ];
    const count = drawQualityConnections(ctx, points,
      [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 0, end: 3 }],
      { x: 0, y: 0, width: 640, height: 360 }, '#4ade80');
    expect(count).toBe(1);
    expect(ctx.moveTo).toHaveBeenCalledTimes(1);
    expect(ctx.lineTo).toHaveBeenCalledTimes(1);
  });
  it('resets motion trails when the detector snaps across the screen', () => {
    const trails = new Map();
    const rect = containedVideoRect(500, 500, 500, 500);
    updateTrail(trails, 'pose-0-15', { x: 0.1, y: 0.1 }, rect, 12, 50);
    updateTrail(trails, 'pose-0-15', { x: 0.12, y: 0.12 }, rect, 12, 50);
    expect(trails.get('pose-0-15')).toHaveLength(2);
    updateTrail(trails, 'pose-0-15', { x: 0.8, y: 0.8 }, rect, 12, 50);
    expect(trails.get('pose-0-15')).toHaveLength(1);
  });

  it('draws an actual face box when 478 landmarks exist and restores paths', () => {
    // Roughly an in-frame face near the left side of a 16:9 CCTV image.
    const face = Array.from({ length: 478 }, (_, index) => ({
      x: 0.25 + (index % 22) * 0.008,
      y: 0.22 + Math.floor(index / 22) * 0.011,
    }));
    const rect = containedVideoRect(960, 540, 1920, 1080);
    const ctx = {
      save: vi.fn(), restore: vi.fn(), strokeRect: vi.fn(), setLineDash: vi.fn(),
      beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
      strokeStyle: '', lineWidth: 0, lineCap: 'butt', lineJoin: 'miter', globalAlpha: 1,
    } as unknown as CanvasRenderingContext2D;
    const bounds = faceLandmarkBounds(face, rect);
    expect(bounds?.width).toBeGreaterThan(100);
    expect(bounds?.x).toBeGreaterThan(100);
    expect(drawFaceLandmarkBounds(ctx, face, rect)).toBe(true);
    expect(ctx.strokeRect).toHaveBeenCalledTimes(1);
    const edges = drawConnections(ctx, face,
      [{ start: 5, end: 6 }, { start: 20, end: 21 }], rect, '#22d3ee');
    expect(edges).toBe(2);
    expect(ctx.lineTo).toHaveBeenCalledTimes(2);
  });
  it('rejects off-camera/empty/implausibly large face boxes', () => {
    const rect = containedVideoRect(640, 360, 640, 360);
    expect(faceLandmarkBounds([], rect)).toBeNull();
    expect(faceLandmarkBounds(Array.from({ length: 40 }, () => ({ x: -3, y: 2 })), rect)).toBeNull();
    const xSpread = Array.from({ length: 120 }, (_, i) => ({ x: i / 119, y: i / 119 }));
    expect(faceLandmarkBounds(xSpread, rect)).toBeNull();
  });

  it('renders face mesh when MediaPipe marks visibility as unsupported/zero', () => {
    const rawFace = Array.from({ length: 478 }, (_, index) => ({
      x: 0.20 + (index % 22) * 0.013,
      y: 0.25 + Math.floor(index / 22) * 0.014,
      visibility: 0, presence: 0,
    }));
    const face = imageLandmarks(rawFace);
    expect(face[0]).toEqual({ x: rawFace[0].x, y: rawFace[0].y });
    expect(usableFaceLandmarks(face)).toBe(true);
    expect(validLandmarkCount(face)).toBe(478);
    const ctx = {
      save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(),
      lineTo: vi.fn(), stroke: vi.fn(), strokeRect: vi.fn(), setLineDash: vi.fn(),
      strokeStyle: '', lineWidth: 0, lineCap: 'butt', lineJoin: 'miter', globalAlpha: 1,
    } as unknown as CanvasRenderingContext2D;
    const rect = containedVideoRect(800, 500, 1920, 1080);
    expect(drawConnections(ctx, rawFace, [{ start: 0, end: 1 }], rect, '#22d3ee')).toBe(0);
    expect(drawConnections(ctx, face,
      [{ start: 0, end: 1 }, { start: 5, end: 7 }], rect, '#22d3ee')).toBe(2);
    expect(drawFaceLandmarkBounds(ctx, face, rect)).toBe(true);
  });

  it('generates closed mouth and eye contours for 68-point fallback', () => {
    expect(FACE_68_CONNECTIONS.some(edge => edge.start === 41 && edge.end === 36)).toBe(true);
    expect(FACE_68_CONNECTIONS.some(edge => edge.start === 67 && edge.end === 60)).toBe(true);
    expect(FACE_68_CONNECTIONS.some(edge => edge.start === 0 && edge.end === 1)).toBe(true);
    expect(usableFaceLandmarks(Array.from({ length: 68 }, () => ({ x: 0.5, y: 0.5 })))).toBe(false);
  });

});
