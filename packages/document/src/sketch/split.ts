import type { SketchEntityId, SketchGeometry, Vec2 } from '@cardstock/types';

/**
 * Where a curve is divided by the points that lie on it.
 *
 * A sketch curve has no ends of its own beyond the two it was drawn with, so anything
 * that merely TOUCHES it part-way along is invisible to the rest of the system: the
 * profile tracer turns corners only where segments share an end, so a chord across a
 * circle enclosed nothing, and a trim had no piece to take away. Both now ask the same
 * question here — "where do points sit on this curve?" — and act on the answer.
 *
 * Positions are compared at the tolerance that decides whether two ends meet, so a point
 * close enough to close a loop is close enough to cut one.
 */

export const TOLERANCE = 1e-6;

export const positionKey = (p: Vec2): string =>
  `${Math.round(p.x / TOLERANCE)},${Math.round(p.y / TOLERANCE)}`;

export interface CurvePiece {
  readonly from: Vec2;
  readonly to: Vec2;
  /** The sketch points the piece runs between, where one exists at that position. */
  readonly fromId: SketchEntityId | null;
  readonly toId: SketchEntityId | null;
  /** Present for a piece of a circle or an arc. */
  readonly angles: { readonly start: number; readonly end: number } | null;
}

type Curve = Extract<SketchGeometry, { type: 'line' | 'circle' | 'arc' }>;
type Point = Extract<SketchGeometry, { type: 'point' }>;

/**
 * The pieces a curve is divided into.
 *
 * One piece means nothing cuts it — for a circle, that one piece is the whole rim, which
 * callers that care about closed curves (the profile builder) treat specially.
 */
export function curvePieces(
  geometry: readonly SketchGeometry[], curve: Curve,
): CurvePiece[] {
  const points = geometry.filter((e): e is Point => e.type === 'point');
  const at = (id: SketchEntityId): Vec2 | null => {
    const entity = geometry.find((e) => e.id === id);
    return entity?.type === 'point' ? { x: entity.x, y: entity.y } : null;
  };
  const idAt = (p: Vec2): SketchEntityId | null =>
    points.find((q) => positionKey(q) === positionKey(p))?.id ?? null;

  if (curve.type === 'line') {
    const from = at(curve.p1), to = at(curve.p2);
    if (!from || !to || positionKey(from) === positionKey(to)) return [];
    const stops = [{ point: from, id: curve.p1 }, ...pointsAlong(points, from, to), { point: to, id: curve.p2 }];
    return stops.slice(0, -1).map((stop, i) => ({
      from: stop.point, to: stops[i + 1]!.point,
      fromId: stop.id ?? idAt(stop.point), toId: stops[i + 1]!.id ?? idAt(stops[i + 1]!.point),
      angles: null,
    }));
  }

  const centre = at(curve.centre);
  if (!centre) return [];
  const on = (angle: number): Vec2 => ({
    x: centre.x + curve.radius * Math.cos(angle),
    y: centre.y + curve.radius * Math.sin(angle),
  });

  if (curve.type === 'circle') {
    const cuts = anglesOnCircle(points, centre, curve.radius);
    // Fewer than two cuts cannot divide a closed curve: with one, the single piece
    // would start and end in the same place, which is a self-loop, not a division.
    if (cuts.length < 2) {
      return [{ from: on(0), to: on(0), fromId: null, toId: null, angles: { start: 0, end: Math.PI * 2 } }];
    }
    return cuts.map((start, i) => {
      const next = cuts[(i + 1) % cuts.length]!;
      const end = next > start ? next : next + Math.PI * 2;
      return {
        from: on(start), to: on(end), fromId: idAt(on(start)), toId: idAt(on(end)),
        angles: { start, end },
      };
    });
  }

  const ends = [curve.startAngle, curve.endAngle] as const;
  const stops = [ends[0], ...anglesWithin(points, centre, curve.radius, ends[0], ends[1]), ends[1]];
  const ids = [curve.start, ...stops.slice(1, -1).map((a) => idAt(on(a))), curve.end];
  return stops.slice(0, -1).map((start, i) => ({
    from: on(start), to: on(stops[i + 1]!),
    fromId: ids[i] ?? null, toId: ids[i + 1] ?? null,
    angles: { start, end: stops[i + 1]! },
  }));
}

/** How far a point is from a piece, for deciding which one the user clicked. */
export function distanceToPiece(piece: CurvePiece, p: Vec2, centre: Vec2 | null): number {
  if (!piece.angles || !centre) {
    const dx = piece.to.x - piece.from.x, dy = piece.to.y - piece.from.y;
    const length = Math.hypot(dx, dy) || 1;
    const at = Math.max(0, Math.min(1, ((p.x - piece.from.x) * dx + (p.y - piece.from.y) * dy) / (length * length)));
    return Math.hypot(p.x - (piece.from.x + dx * at), p.y - (piece.from.y + dy * at));
  }
  const radius = Math.hypot(piece.from.x - centre.x, piece.from.y - centre.y);
  const { start, end } = piece.angles;
  const sweep = end - start;
  // Where round the piece the point lies, measured the way this piece runs.
  const offset = wrap((Math.atan2(p.y - centre.y, p.x - centre.x) - start) * Math.sign(sweep || 1));
  const within = offset <= Math.abs(sweep);
  if (within) return Math.abs(Math.hypot(p.x - centre.x, p.y - centre.y) - radius);
  // Past the end: the nearer of the two ends.
  return Math.min(
    Math.hypot(p.x - piece.from.x, p.y - piece.from.y),
    Math.hypot(p.x - piece.to.x, p.y - piece.to.y),
  );
}

/** Points strictly between `from` and `to` on the straight line through them. */
function pointsAlong(
  points: readonly Point[], from: Vec2, to: Vec2,
): { point: Vec2; id: SketchEntityId }[] {
  const dx = to.x - from.x, dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length <= TOLERANCE) return [];
  const found: { at: number; point: Vec2; id: SketchEntityId }[] = [];
  for (const p of points) {
    if (Math.abs(dx * (from.y - p.y) - dy * (from.x - p.x)) / length > TOLERANCE) continue;
    const at = ((p.x - from.x) * dx + (p.y - from.y) * dy) / (length * length);
    if (at * length <= TOLERANCE || (1 - at) * length <= TOLERANCE) continue;
    found.push({ at, point: { x: p.x, y: p.y }, id: p.id });
  }
  // Two points in the same place cut the line once. A sketch has coincident points
  // everywhere — the origin and a point drawn on it, or two ends held together — and
  // cutting twice leaves a zero-length piece, which is a self-loop in the graph: the
  // profile trace stopped dead on it and came back empty.
  const sorted = found.sort((a, b) => a.at - b.at);
  return sorted
    .filter((f, i) => i === 0 || positionKey(f.point) !== positionKey(sorted[i - 1]!.point))
    .map(({ point, id }) => ({ point, id }));
}

/** The angles, in order, at which points sit on a full circle. */
function anglesOnCircle(points: readonly Point[], centre: Vec2, radius: number): number[] {
  const angles = points
    .filter((p) => Math.abs(Math.hypot(p.x - centre.x, p.y - centre.y) - radius) <= TOLERANCE)
    .map((p) => wrap(Math.atan2(p.y - centre.y, p.x - centre.x)));
  const cuts = dedupe(angles.sort((a, b) => a - b));
  // A cut at 0 and another a hair short of 2π are the same place on the rim.
  if (cuts.length > 1 && Math.PI * 2 - cuts[cuts.length - 1]! + cuts[0]! < 1e-9) cuts.pop();
  return cuts;
}

/** The angles at which points sit strictly inside an arc's own sweep, in sweep order. */
function anglesWithin(
  points: readonly Point[], centre: Vec2, radius: number, startAngle: number, endAngle: number,
): number[] {
  const sweep = endAngle - startAngle;
  if (Math.abs(sweep) <= TOLERANCE) return [];
  const direction = Math.sign(sweep);
  const found: number[] = [];
  for (const p of points) {
    if (Math.abs(Math.hypot(p.x - centre.x, p.y - centre.y) - radius) > TOLERANCE) continue;
    const offset = wrap((Math.atan2(p.y - centre.y, p.x - centre.x) - startAngle) * direction);
    if (offset <= TOLERANCE || offset >= Math.abs(sweep) - TOLERANCE) continue;
    found.push(startAngle + offset * direction);
  }
  return dedupe(found.sort((a, b) => (sweep > 0 ? a - b : b - a)));
}

/** 0..2π. */
function wrap(angle: number): number {
  const a = angle % (Math.PI * 2);
  return a < 0 ? a + Math.PI * 2 : a;
}

function dedupe(sorted: readonly number[]): number[] {
  const out: number[] = [];
  for (const angle of sorted) {
    if (out.length === 0 || Math.abs(angle - out[out.length - 1]!) > 1e-9) out.push(angle);
  }
  return out;
}
