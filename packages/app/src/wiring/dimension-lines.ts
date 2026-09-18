import type { Vec2 } from '@cardstock/types';

/**
 * The lines that go with a dimension, drawn the way an engineering drawing draws them.
 *
 * A linear dimension gets two EXTENSION lines, one from each measured point, leaving a
 * small gap at the geometry and running a little past the DIMENSION line, which runs
 * parallel to what it measures, offset from it, with an arrowhead at each end and its
 * value in the middle. A radius gets a leader from the centre through the rim; an angle
 * gets an arc between its lines. Distances to a line are measured perpendicular to it,
 * and the line is extended if the perpendicular lands beyond its end.
 *
 * Sizes are in PIXELS and scaled to sketch units by the caller, so the drawing stays
 * the same size on screen however far the user has zoomed.
 */
export interface Segment { readonly from: Vec2; readonly to: Vec2 }

export interface DimensionDrawing {
  readonly segments: Segment[];
  /** Where the value sits. */
  readonly anchor: Vec2;
}

/** Drawing sizes, in screen pixels. */
export const DIMENSION_STYLE = {
  offset: 26,     // dimension line's distance from the geometry
  gap: 3,         // extension line stops short of the geometry
  overshoot: 6,   // and runs this far past the dimension line
  arrow: 9,       // arrowhead length
  arrowSpread: 0.28,
  radiusLead: 18, // how far a radius leader runs past the rim
};

const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;
const len = (a: Vec2) => Math.hypot(a.x, a.y);
const unit = (a: Vec2): Vec2 => { const l = len(a) || 1; return { x: a.x / l, y: a.y / l }; };
const perp = (a: Vec2): Vec2 => ({ x: -a.y, y: a.x });
const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** Arrowhead at `tip`, pointing along `direction` (which points INTO the tip). */
function arrowhead(tip: Vec2, direction: Vec2, size: number): Segment[] {
  const back = mul(unit(direction), -size);
  const side = mul(perp(unit(direction)), size * DIMENSION_STYLE.arrowSpread);
  return [
    { from: tip, to: add(add(tip, back), side) },
    { from: tip, to: sub(add(tip, back), side) },
  ];
}

/**
 * A dimension line between two points, with arrows pointing outward to its ends.
 * Extension lines are drawn from `fromGeometry` and `toGeometry` when given.
 */
function linear(
  a: Vec2, b: Vec2, unitsPerPixel: number,
  extensions: { a: Vec2; b: Vec2 } | null,
): DimensionDrawing {
  const s = DIMENSION_STYLE;
  const dir = unit(sub(b, a));
  const segments: Segment[] = [{ from: a, to: b }];
  segments.push(...arrowhead(a, mul(dir, -1), s.arrow * unitsPerPixel));
  segments.push(...arrowhead(b, dir, s.arrow * unitsPerPixel));
  if (extensions) {
    for (const [geometryPoint, end] of [[extensions.a, a], [extensions.b, b]] as const) {
      const toward = sub(end, geometryPoint);
      if (len(toward) < 1e-9) continue;
      const n = unit(toward);
      segments.push({
        from: add(geometryPoint, mul(n, s.gap * unitsPerPixel)),
        to: add(end, mul(n, s.overshoot * unitsPerPixel)),
      });
    }
  }
  return { segments, anchor: mid(a, b) };
}

/** Point to point, offset to the side away from `awayFrom` (the sketch's centre). */
export function pointToPoint(a: Vec2, b: Vec2, awayFrom: Vec2, unitsPerPixel: number): DimensionDrawing {
  const dir = unit(sub(b, a));
  let n = perp(dir);
  if (dot(n, sub(mid(a, b), awayFrom)) < 0) n = mul(n, -1);
  const off = mul(n, DIMENSION_STYLE.offset * unitsPerPixel);
  return linear(add(a, off), add(b, off), unitsPerPixel, { a, b });
}

/** Where the perpendicular from `p` meets the line through a–b, and whether that
 *  falls on the segment. */
function footOn(p: Vec2, a: Vec2, b: Vec2) {
  const dir = unit(sub(b, a));
  const t = dot(sub(p, a), dir);
  return { foot: add(a, mul(dir, t)), dir, onSegment: t >= 0 && t <= len(sub(b, a)) };
}

/** The line, extended past its nearer end to `foot` when the foot is off the segment. */
function lineExtension(foot: Vec2, a: Vec2, b: Vec2, onSegment: boolean, unitsPerPixel: number): Segment[] {
  if (onSegment) return [];
  const nearer = len(sub(foot, a)) < len(sub(foot, b)) ? a : b;
  const dir = unit(sub(foot, nearer));
  return [{ from: nearer, to: add(foot, mul(dir, DIMENSION_STYLE.overshoot * unitsPerPixel)) }];
}

/** Perpendicular distance from a point to a line. */
export function pointToLine(p: Vec2, a: Vec2, b: Vec2, unitsPerPixel: number): DimensionDrawing {
  const { foot, onSegment } = footOn(p, a, b);
  if (len(sub(p, foot)) < 1e-9) return { segments: [], anchor: p };
  const drawing = linear(foot, p, unitsPerPixel, null);
  drawing.segments.push(...lineExtension(foot, a, b, onSegment, unitsPerPixel));
  return drawing;
}

/** Between parallel lines: from the middle of the first, perpendicular to the second. */
export function lineToLine(a: { a: Vec2; b: Vec2 }, b: { a: Vec2; b: Vec2 }, unitsPerPixel: number): DimensionDrawing {
  const start = mid(a.a, a.b);
  const { foot, onSegment } = footOn(start, b.a, b.b);
  if (len(sub(start, foot)) < 1e-9) return { segments: [], anchor: start };
  const drawing = linear(foot, start, unitsPerPixel, null);
  drawing.segments.push(...lineExtension(foot, b.a, b.b, onSegment, unitsPerPixel));
  return drawing;
}

/** From a point to a circle's rim, along the line through the centre. */
export function pointToCircle(p: Vec2, centre: Vec2, radius: number, unitsPerPixel: number): DimensionDrawing {
  const dir = unit(sub(p, centre));
  const rim = add(centre, mul(dir, radius));
  if (len(sub(p, rim)) < 1e-9) return { segments: [], anchor: rim };
  return linear(rim, p, unitsPerPixel, null);
}

/** From a circle's rim to a line, perpendicular to the line. */
export function circleToLine(centre: Vec2, radius: number, a: Vec2, b: Vec2, unitsPerPixel: number): DimensionDrawing {
  const { foot, onSegment } = footOn(centre, a, b);
  const n = unit(sub(foot, centre));
  const rim = add(centre, mul(n, radius));
  if (len(sub(rim, foot)) < 1e-9) return { segments: [], anchor: rim };
  const drawing = linear(rim, foot, unitsPerPixel, null);
  drawing.segments.push(...lineExtension(foot, a, b, onSegment, unitsPerPixel));
  return drawing;
}

/** A radius: a leader from the centre out through the rim, arrow at the rim, value beyond.
 *  `through` is the angle the leader leaves at — the middle of an arc, or 45° for a circle. */
export function radius(centre: Vec2, r: number, unitsPerPixel: number, through = Math.PI / 4): DimensionDrawing {
  const dir = { x: Math.cos(through), y: Math.sin(through) };
  const rim = add(centre, mul(dir, r));
  const end = add(rim, mul(dir, DIMENSION_STYLE.radiusLead * unitsPerPixel));
  return {
    segments: [{ from: centre, to: end }, ...arrowhead(rim, dir, DIMENSION_STYLE.arrow * unitsPerPixel)],
    anchor: add(end, mul(dir, 8 * unitsPerPixel)),
  };
}

/** A diameter: straight through the centre, arrows at both rims. */
export function diameter(centre: Vec2, r: number, unitsPerPixel: number): DimensionDrawing {
  const dir = unit({ x: 1, y: 1 });
  const drawing = linear(sub(centre, mul(dir, r)), add(centre, mul(dir, r)), unitsPerPixel, null);
  return { segments: drawing.segments, anchor: add(centre, mul(perp(dir), 10 * unitsPerPixel)) };
}

/** An arc's sweep: a concentric arc just outside it, arrows at both ends, value at the middle. */
export function arcSweep(centre: Vec2, r: number, start: number, sweep: number, unitsPerPixel: number): DimensionDrawing {
  const rr = r + DIMENSION_STYLE.offset * 0.6 * unitsPerPixel;
  const steps = 24;
  const at = (k: number): Vec2 => {
    const th = start + (sweep * k) / steps;
    return add(centre, { x: rr * Math.cos(th), y: rr * Math.sin(th) });
  };
  const segments: Segment[] = [];
  for (let k = 0; k < steps; k++) segments.push({ from: at(k), to: at(k + 1) });
  const tangent = (th: number, sign: number): Vec2 => ({ x: -Math.sin(th) * sign, y: Math.cos(th) * sign });
  segments.push(...arrowhead(at(0), tangent(start, -1), DIMENSION_STYLE.arrow * unitsPerPixel));
  segments.push(...arrowhead(at(steps), tangent(start + sweep, 1), DIMENSION_STYLE.arrow * unitsPerPixel));
  // Extension ticks from the arc's ends out to the dimension arc.
  for (const th of [start, start + sweep]) {
    segments.push({
      from: add(centre, { x: (r + DIMENSION_STYLE.gap * unitsPerPixel) * Math.cos(th), y: (r + DIMENSION_STYLE.gap * unitsPerPixel) * Math.sin(th) }),
      to: add(centre, { x: (rr + DIMENSION_STYLE.overshoot * unitsPerPixel) * Math.cos(th), y: (rr + DIMENSION_STYLE.overshoot * unitsPerPixel) * Math.sin(th) }),
    });
  }
  const midAngle = start + sweep / 2;
  const labelR = rr + 12 * unitsPerPixel;
  return { segments, anchor: add(centre, { x: labelR * Math.cos(midAngle), y: labelR * Math.sin(midAngle) }) };
}

/** The angle between two lines: an arc about their intersection, arrows at both ends. */
export function angle(a: { a: Vec2; b: Vec2 }, b: { a: Vec2; b: Vec2 }, unitsPerPixel: number): DimensionDrawing {
  const da = sub(a.b, a.a), db = sub(b.b, b.a);
  const det = da.x * db.y - da.y * db.x;
  if (Math.abs(det) < 1e-9) return { segments: [], anchor: mid(mid(a.a, a.b), mid(b.a, b.b)) };
  const t = ((b.a.x - a.a.x) * db.y - (b.a.y - a.a.y) * db.x) / det;
  const vertex = add(a.a, mul(da, t));
  // Point each direction toward the side of its line that is further from the vertex,
  // so the arc sits between the lines as drawn rather than their extensions.
  const away = (l: { a: Vec2; b: Vec2 }) =>
    unit(sub(len(sub(l.b, vertex)) > len(sub(l.a, vertex)) ? l.b : l.a, vertex));
  const ua = away(a), ub = away(b);
  const start = Math.atan2(ua.y, ua.x);
  let sweep = Math.atan2(ub.y, ub.x) - start;
  while (sweep > Math.PI) sweep -= Math.PI * 2;
  while (sweep < -Math.PI) sweep += Math.PI * 2;
  const r = DIMENSION_STYLE.offset * 1.4 * unitsPerPixel;
  const steps = 16;
  const at = (k: number): Vec2 => {
    const th = start + (sweep * k) / steps;
    return add(vertex, { x: r * Math.cos(th), y: r * Math.sin(th) });
  };
  const segments: Segment[] = [];
  for (let k = 0; k < steps; k++) segments.push({ from: at(k), to: at(k + 1) });
  const tangent = (th: number, sign: number): Vec2 => ({ x: -Math.sin(th) * sign, y: Math.cos(th) * sign });
  const s = Math.sign(sweep) || 1;
  segments.push(...arrowhead(at(0), tangent(start, -s), DIMENSION_STYLE.arrow * unitsPerPixel));
  segments.push(...arrowhead(at(steps), tangent(start + sweep, s), DIMENSION_STYLE.arrow * unitsPerPixel));
  const midAngle = start + sweep / 2;
  return {
    segments,
    anchor: add(vertex, { x: (r + 12 * unitsPerPixel) * Math.cos(midAngle), y: (r + 12 * unitsPerPixel) * Math.sin(midAngle) }),
  };
}
