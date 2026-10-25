/** Geometry for the optional CCTV tracing overlay, independent of alert fusion.
 * Coordinates are normalized MediaPipe landmark points, not identities.
 */
export interface TracePoint { x: number; y: number; visibility?: number; }
export interface TraceConnection { start: number; end: number; }
export interface TraceRect { x: number; y: number; width: number; height: number; }

export function containedVideoRect(
  width: number, height: number, videoWidth: number, videoHeight: number,
): TraceRect {
  if (width <= 0 || height <= 0 || videoWidth <= 0 || videoHeight <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const scale = Math.min(width / videoWidth, height / videoHeight);
  const w = videoWidth * scale;
  const h = videoHeight * scale;
  return { x: (width - w) / 2, y: (height - h) / 2, width: w, height: h };
}

export function toCanvasPoint(point: TracePoint, rect: TraceRect): { x: number; y: number } | null {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  // Clamp small predictions outside view, but do not project off-camera points.
  if (point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) return null;
  return { x: rect.x + point.x * rect.width, y: rect.y + point.y * rect.height };
}

export function drawConnections(
  ctx: CanvasRenderingContext2D, landmarks: readonly TracePoint[],
  connections: readonly TraceConnection[], rect: TraceRect, color: string,
  opacity = 0.85, lineWidth = 1.5,
): void {
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = color;
  ctx.beginPath();
  for (const { start, end } of connections) {
    const a = landmarks[start], b = landmarks[end];
    if (!a || !b || (a.visibility ?? 1) < 0.45 || (b.visibility ?? 1) < 0.45) continue;
    const p = toCanvasPoint(a, rect), q = toCanvasPoint(b, rect);
    if (!p || !q) continue;
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(q.x, q.y);
  }
  ctx.stroke();
  ctx.restore();
}

export function drawPoints(
  ctx: CanvasRenderingContext2D, landmarks: readonly TracePoint[], indices: readonly number[],
  rect: TraceRect, color: string,
): void {
  ctx.save();
  ctx.fillStyle = color;
  for (const index of indices) {
    const point = landmarks[index];
    if (!point || (point.visibility ?? 1) < 0.45) continue;
    const pos = toCanvasPoint(point, rect);
    if (!pos) continue;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

export type TraceTrail = { x: number; y: number }[];
export function updateTrail(
  trails: Map<string, TraceTrail>, key: string, point: TracePoint | undefined,
  rect: TraceRect, maxPoints = 16,
): TraceTrail {
  const position = point ? toCanvasPoint(point, rect) : null;
  if (!position || (point?.visibility ?? 1) < 0.45) {
    trails.delete(key);
    return [];
  }
  const path = trails.get(key) ?? [];
  path.push(position);
  if (path.length > maxPoints) path.splice(0, path.length - maxPoints);
  trails.set(key, path);
  return path;
}

export function drawTrail(ctx: CanvasRenderingContext2D, trail: TraceTrail, color: string): void {
  if (trail.length < 2) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  trail.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.stroke();
  ctx.restore();
}
