/** Geometry for the optional CCTV tracing overlay, independent of alert fusion.
 * Coordinates are normalized MediaPipe landmark points, not identities.
 */
export interface TracePoint { x: number; y: number; visibility?: number; presence?: number; }
export interface TraceConnection { start: number; end: number; }
export interface TraceRect { x: number; y: number; width: number; height: number; }

/** Face and hand mesh models return coordinates, but do not consistently
 * estimate per-point visibility. Some runtimes populate visibility=0
 * as an unsupported/default value. Do not interpret that as occlusion.
 *
 * Pose Landmarker DOES estimate visibility; its data is kept intact and
 * checked separately to avoid connecting hallucinated body joints.
 */
export function imageLandmarks(points: readonly TracePoint[]): TracePoint[] {
  return points.map(point => ({ x: point.x, y: point.y }));
}

/** Basic geometry validity, independent of optional visibility metadata. */
export function validLandmarkCount(points: readonly TracePoint[]): number {
  return points.reduce((count, point) =>
    count + (Number.isFinite(point.x) && Number.isFinite(point.y)
      && point.x >= 0 && point.x <= 1
      && point.y >= 0 && point.y <= 1 ? 1 : 0), 0);
}

/** Reject implausibly compact/degenerate face geometry, not low visibility
 * scores unsupported by Face Landmarker.
 */
export function usableFaceLandmarks(points: readonly TracePoint[]): boolean {
  if (points.length < 20 || validLandmarkCount(points) < points.length * 0.55) return false;
  let minX = 1, maxX = 0, minY = 1, maxY = 0;
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)
        || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) continue;
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  return maxX - minX > 0.035 && maxY - minY > 0.045;
}

export const FACE_68_CONNECTIONS: TraceConnection[] = [
  ...[[0,16], [17,21], [22,26], [27,30], [31,35], [36,41], [42,47], [48,59], [60,67]]
    .flatMap(([from, to]) => Array.from({ length: to - from },
      (_, index) => ({ start: from + index, end: from + index + 1 }))),
  ...[36, 42, 48, 60].map(index => ({
    start: index === 36 ? 41 : index === 42 ? 47 : index === 48 ? 59 : 67,
    end: index,
  })),
];

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
): number {
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  let drawn = 0;
  ctx.beginPath();
  for (const { start, end } of connections) {
    const a = landmarks[start], b = landmarks[end];
    if (!a || !b || (a.visibility ?? 1) < 0.45 || (b.visibility ?? 1) < 0.45) continue;
    const p = toCanvasPoint(a, rect), q = toCanvasPoint(b, rect);
    if (!p || !q) continue;
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(q.x, q.y);
    drawn++;
  }
  ctx.stroke();
  ctx.restore();
  return drawn;
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
  rect: TraceRect, maxPoints = 16, maxJumpPx = Number.POSITIVE_INFINITY,
): TraceTrail {
  const position = point ? toCanvasPoint(point, rect) : null;
  if (!position || (point?.visibility ?? 1) < 0.45) {
    trails.delete(key);
    return [];
  }
  const path = trails.get(key) ?? [];
  // If a detector suddenly snaps to a distant body part, never connect
  // both positions with a misleading movement streak across the CCTV image.
  const last = path[path.length - 1];
  if (last && Math.hypot(last.x - position.x, last.y - position.y) > maxJumpPx) {
    path.length = 0;
  }
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


/** Smooth detected coordinates without inventing or carrying lost landmarks.
 * Only safe for a single ephemeral, current-frame track, not person identity.
 */
export function smoothLandmarks(
  previous: readonly TracePoint[] | null, current: readonly TracePoint[],
  alpha = 0.55, maxJump = 0.18,
): TracePoint[] {
  if (!previous || previous.length !== current.length) return current.map(point => ({ ...point }));
  const weight = Math.max(0, Math.min(1, alpha));
  return current.map((point, index) => {
    const before = previous[index];
    if (!before || !Number.isFinite(point.x) || !Number.isFinite(point.y)
        || !Number.isFinite(before.x) || !Number.isFinite(before.y)
        || (point.visibility ?? 1) < 0.55 || (point.presence ?? 1) < 0.55
        || Math.hypot(point.x - before.x, point.y - before.y) > maxJump) {
      return { ...point };
    }
    return {
      ...point,
      x: before.x + weight * (point.x - before.x),
      y: before.y + weight * (point.y - before.y),
    };
  });
}

/** Reject implausible/occluded body segments rather than drawing diagonal
 * lines across the entire camera from hallucinated off-screen joints.
 * This is visual quality filtering only, never a distress detection.
 */
export function drawQualityConnections(
  ctx: CanvasRenderingContext2D, landmarks: readonly TracePoint[],
  connections: readonly TraceConnection[], rect: TraceRect, color: string,
  options: { minVisibility?: number; maxLength?: number; lineWidth?: number; opacity?: number } = {},
): number {
  const { minVisibility = 0.65, maxLength = 0.40, lineWidth = 2.5, opacity = 0.9 } = options;
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  let count = 0;
  ctx.beginPath();
  for (const { start, end } of connections) {
    const a = landmarks[start], b = landmarks[end];
    if (!a || !b
        || (a.visibility ?? 1) < minVisibility || (b.visibility ?? 1) < minVisibility
        || (a.presence ?? 1) < minVisibility || (b.presence ?? 1) < minVisibility
        || Math.hypot(a.x - b.x, a.y - b.y) > maxLength) continue;
    const p = toCanvasPoint(a, rect), q = toCanvasPoint(b, rect);
    if (!p || !q) continue;
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(q.x, q.y);
    count += 1;
  }
  ctx.stroke();
  ctx.restore();
  return count;
}


/** A deliberately simple face-localization fallback: landmark-derived geometry
 * remains visible even if a model's connection topology is unavailable or too
 * noisy for useful lines. This is NOT a face-recognition identity box.
 *
 * Trim the outlying ~3% of points to keep errant landmark positions from
 * producing the full-screen rectangles seen with unstable indoor detections.
 */
export function faceLandmarkBounds(
  landmarks: readonly TracePoint[], rect: TraceRect,
): TraceRect | null {
  if (!(rect.width > 0 && rect.height > 0)) return null;
  const valid = landmarks.filter(point =>
    Number.isFinite(point.x) && Number.isFinite(point.y)
    && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1
    && (point.visibility ?? 1) >= 0.3);
  if (valid.length < 20) return null;
  const xs = valid.map(point => point.x).sort((a, b) => a - b);
  const ys = valid.map(point => point.y).sort((a, b) => a - b);
  const lo = Math.floor((valid.length - 1) * 0.03);
  const hi = Math.ceil((valid.length - 1) * 0.97);
  const left = rect.x + xs[lo] * rect.width;
  const top = rect.y + ys[lo] * rect.height;
  const width = (xs[hi] - xs[lo]) * rect.width;
  const height = (ys[hi] - ys[lo]) * rect.height;
  if (width < rect.width * 0.02 || height < rect.height * 0.02
      || width > rect.width * 0.90 || height > rect.height * 0.90) return null;
  return { x: left, y: top, width, height };
}

export function drawFaceLandmarkBounds(
  ctx: CanvasRenderingContext2D, landmarks: readonly TracePoint[],
  rect: TraceRect, color = '#67e8f9',
): boolean {
  const bounds = faceLandmarkBounds(landmarks, rect);
  if (!bounds) return false;
  ctx.save();
  ctx.lineWidth = 2;
  ctx.strokeStyle = color;
  ctx.setLineDash([7, 5]);
  ctx.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
  ctx.restore();
  return true;
}

/** Persistent, solid face-localization overlay for an online CCTV camera.
 * Coordinates come from the current frame only; this is not face identity
 * recognition and it does not influence emergency validation.
 */
export function drawSolidFaceBox(
  ctx: CanvasRenderingContext2D, landmarks: readonly TracePoint[],
  rect: TraceRect, color = '#22d3ee',
): boolean {
  const bounds = faceLandmarkBounds(landmarks, rect);
  if (!bounds) return false;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.setLineDash([]);
  ctx.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
  const label = 'FACE';
  ctx.font = 'bold 13px sans-serif';
  const textWidth = ctx.measureText(label).width + 12;
  const labelY = Math.max(rect.y, bounds.y - 23);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.78)';
  ctx.fillRect(bounds.x, labelY, textWidth, 21);
  ctx.fillStyle = color;
  ctx.fillText(label, bounds.x + 6, labelY + 15);
  ctx.restore();
  return true;
}
