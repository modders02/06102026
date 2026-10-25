import { describe, expect, it, vi } from 'vitest';
import { containedVideoRect, toCanvasPoint, drawConnections, updateTrail, drawTrail } from '@/lib/landmarkRendering';

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
});
