import type { ProfileSegment, SketchGeometry, Vec2 } from '@cardstock/types';

/**
 * Turn solved sketch geometry into closed loops a kernel can make faces from.
 *
 * Adjacency is decided by POSITION, not by shared point ids. Two ends may be the same
 * point, or two distinct points held together by a coincident constraint — after solving
 * both look identical on screen, and a profile that worked one way but not the other
 * would be baffling.
 *
 * Construction geometry is excluded: it exists to constrain, not to enclose.
 */

export interface ProfileLoop {
  readonly segments: readonly ProfileSegment[];
  /** True for a full circle, which is closed without any chaining. */
  readonly closed: boolean;
  /** Positive when the loop runs counter-clockwise. */
  readonly signedArea: number;
}

export type { ProfileSegment };

export interface ProfileResult {
  readonly loops: readonly ProfileLoop[];
  /** Segments that belong to no closed loop, with why — shown to the user as gaps. */
  readonly openChains: readonly { readonly segments: readonly ProfileSegment[]; readonly reason: string }[];
}

const TOLERANCE = 1e-6;
const key = (p: Vec2): string =>
  `${Math.round(p.x / TOLERANCE)},${Math.round(p.y / TOLERANCE)}`;

const positionOf = (geometry: readonly SketchGeometry[], id: string): Vec2 | null => {
  const entity = geometry.find((e) => e.id === id);
  return entity?.type === 'point' ? { x: entity.x, y: entity.y } : null;
};

/**
 * Signed area; its sign gives the winding direction.
 *
 * Shoelace over the chords, plus the circular segment each arc bulges out by — without
 * that an arc closed by its chord has no area at all, and a D-shape is not a region.
 * A reversed arc carries a negative sweep, so its bulge subtracts, as it should.
 */
export function signedArea(segments: readonly ProfileSegment[]): number {
  let total = 0;
  for (const segment of segments) {
    if (segment.kind === 'circle') return Math.PI * segment.radius ** 2;
    total += segment.from.x * segment.to.y - segment.to.x * segment.from.y;
    if (segment.kind === 'arc') {
      let sweep = segment.endAngle - segment.startAngle;
      while (sweep > Math.PI * 2) sweep -= Math.PI * 2;
      while (sweep < -Math.PI * 2) sweep += Math.PI * 2;
      total += segment.radius ** 2 * (sweep - Math.sin(sweep));
    }
  }
  return total / 2;
}

export function buildProfile(geometry: readonly SketchGeometry[]): ProfileResult {
  const loops: ProfileLoop[] = [];
  const chainable: ProfileSegment[] = [];
  const points = geometry.filter((e): e is Extract<SketchGeometry, { type: 'point' }> => e.type === 'point');

  for (const entity of geometry) {
    // Points have no construction flag; only curves do.
    if (entity.type !== 'point' && entity.construction) continue;

    if (entity.type === 'circle') {
      const centre = positionOf(geometry, entity.centre);
      if (!centre) continue;
      // Points sitting on the rim cut it up: a circle with a chord across it is two
      // regions, and it can only come out that way if the rim is two arcs that the
      // chord's ends can be joined to.
      const cuts = anglesOn(points, centre, entity.radius);
      if (cuts.length < 2) {
        const segment: ProfileSegment = { kind: 'circle', centre, radius: entity.radius };
        loops.push({ segments: [segment], closed: true, signedArea: signedArea([segment]) });
        continue;
      }
      for (let i = 0; i < cuts.length; i++) {
        const from = cuts[i]!;
        const to = (cuts[(i + 1) % cuts.length]! > from ? cuts[(i + 1) % cuts.length]! : cuts[(i + 1) % cuts.length]! + Math.PI * 2);
        chainable.push(arcSegment(centre, entity.radius, from, to));
      }
      continue;
    }

    if (entity.type === 'line') {
      const from = positionOf(geometry, entity.p1);
      const to = positionOf(geometry, entity.p2);
      // A zero-length line contributes nothing and would create a self-loop in the graph.
      if (!from || !to || key(from) === key(to)) continue;
      // Split where something else touches it. Without this a line that ends part-way
      // along another closes nothing: the tracer only turns corners at shared ends, so
      // a T-junction left both regions open.
      let previous = from;
      for (const cut of pointsAlong(points, from, to)) {
        chainable.push({ kind: 'line', from: previous, to: cut });
        previous = cut;
      }
      chainable.push({ kind: 'line', from: previous, to });
      continue;
    }

    if (entity.type === 'arc') {
      const centre = positionOf(geometry, entity.centre);
      const from = positionOf(geometry, entity.start);
      const to = positionOf(geometry, entity.end);
      if (!centre || !from || !to) continue;
      const ends = [entity.startAngle, entity.endAngle] as const;
      let previous = ends[0];
      for (const cut of anglesBetween(points, centre, entity.radius, ends[0], ends[1])) {
        chainable.push(arcSegment(centre, entity.radius, previous, cut));
        previous = cut;
      }
      chainable.push(arcSegment(centre, entity.radius, previous, ends[1]));
    }
  }

  // --- trace faces of the planar graph the segments form
  //
  // Every segment is a pair of half-edges, one each way. Starting from each unused
  // half-edge, walk: at each vertex take the outgoing half-edge that turns LEFT the
  // least sharply from the one we arrived on — the standard face-tracing rule, which
  // makes every bounded region come out as its own counter-clockwise loop, and the
  // unbounded outside of each connected piece as one clockwise loop. That is what
  // makes a junction unambiguous: two triangles sharing a corner are two faces, not
  // a puzzle about which way round to go.
  type Directed = Extract<ProfileSegment, { from: Vec2 }>;
  const directed: Directed[] = [];
  for (const segment of chainable) {
    if (segment.kind === 'circle') continue;
    directed.push(segment, reverse(segment) as Directed);
  }
  const outgoing = new Map<string, number[]>();
  directed.forEach((segment, index) => {
    const k = key(segment.from);
    outgoing.set(k, [...(outgoing.get(k) ?? []), index]);
  });
  // Segments with a dangling end can never close; peel them off (repeatedly, since
  // removing one can strand its neighbour) and report them as the gap.
  const dangling = new Set<number>();
  const alive = (k: string) => (outgoing.get(k) ?? []).filter((i) => !dangling.has(i)).length;
  for (let changed = true; changed;) {
    changed = false;
    directed.forEach((segment, index) => {
      if (dangling.has(index)) return;
      if (alive(key(segment.from)) < 2 || alive(key(segment.to)) < 2) {
        dangling.add(index).add(index ^ 1);
        changed = true;
      }
    });
  }

  const openChains: { segments: ProfileSegment[]; reason: string }[] = [];
  const loose = directed.filter((_, i) => i % 2 === 0 && dangling.has(i));
  if (loose.length > 0) {
    // Loose segments become a path only if they form a simple chain. Three meeting at
    // a point is neither a loop nor a path, and naming that beats sweeping along a Y.
    const ends = new Map<string, number>();
    for (const segment of loose) {
      for (const end of [segment.from, segment.to]) ends.set(key(end), (ends.get(key(end)) ?? 0) + 1);
    }
    const branched = [...ends.values()].some((n) => n > 2);
    openChains.push({
      segments: chainSegments(loose),
      reason: branched
        ? 'more than two segments meet at a point, so the profile is ambiguous'
        : 'the profile does not close',
    });
  }

  const used = new Set<number>(dangling);
  for (let start = 0; start < directed.length; start++) {
    if (used.has(start)) continue;
    const chain: ProfileSegment[] = [];
    let current = start;
    let closed = false;
    for (let guard = 0; guard <= directed.length; guard++) {
      used.add(current);
      const segment = directed[current]!;
      chain.push(segment);
      const arriving = endDirection(segment);
      const back = { x: -arriving.x, y: -arriving.y };
      // Leftmost turn: the largest counter-clockwise angle from the way we came.
      let next = -1, bestAngle = -Infinity;
      for (const i of outgoing.get(key(segment.to)) ?? []) {
        if (i === (current ^ 1) || dangling.has(i)) continue;
        const dir = startDirection(directed[i]!);
        let angle = Math.atan2(back.x * dir.y - back.y * dir.x, back.x * dir.x + back.y * dir.y);
        if (angle <= 1e-9) angle += Math.PI * 2;
        if (angle > bestAngle) { bestAngle = angle; next = i; }
      }
      if (next === start) { closed = true; break; }
      if (next < 0 || used.has(next)) break;
      current = next;
    }
    if (!closed) continue;
    const area = signedArea(chain);
    // Clockwise loops are the outside of a connected piece, not a region.
    if (area > TOLERANCE) loops.push({ segments: chain, closed: true, signedArea: area });
  }

  return { loops, openChains };
}

/**
 * Where points lie ON a curve, in the order the curve passes them.
 *
 * This is what makes a curve divisible. The face tracer turns corners only where
 * segments share an END, so a curve that another one merely touches part-way along was
 * an uncrossable wall: a chord drawn across a circle enclosed nothing, and a line
 * running into the middle of another left both sides open. Cutting each curve at the
 * points that sit on it turns those touches into real corners, and everything else —
 * winding, nesting, holes — follows as before.
 *
 * Positions are compared at the same tolerance that decides whether two ends meet, so
 * a point close enough to close a loop is close enough to cut one.
 */
const on = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y) <= TOLERANCE;

/** Points strictly between `from` and `to` on the straight line through them. */
function pointsAlong(
  points: readonly { x: number; y: number }[], from: Vec2, to: Vec2,
): Vec2[] {
  const dx = to.x - from.x, dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length <= TOLERANCE) return [];
  const found: { at: number; point: Vec2 }[] = [];
  for (const p of points) {
    if (on(p, from) || on(p, to)) continue;
    // Distance from the infinite line, then position along it.
    if (Math.abs(dx * (from.y - p.y) - dy * (from.x - p.x)) / length > TOLERANCE) continue;
    const at = ((p.x - from.x) * dx + (p.y - from.y) * dy) / (length * length);
    if (at <= 0 || at >= 1) continue;
    found.push({ at, point: { x: p.x, y: p.y } });
  }
  // Two points in the same place cut the line once. A sketch routinely has several —
  // the origin and a point drawn on it, or two ends held together by a coincident —
  // and cutting twice leaves a zero-length piece, which is a self-loop in the graph
  // and stops the trace dead: the whole profile came back empty.
  const sorted = found.sort((a, b) => a.at - b.at).map((f) => f.point);
  return sorted.filter((point, i) => i === 0 || key(point) !== key(sorted[i - 1]!));
}

/** The angles, sorted, at which points sit on a full circle. */
function anglesOn(
  points: readonly { x: number; y: number }[], centre: Vec2, radius: number,
): number[] {
  const angles = points
    .filter((p) => Math.abs(Math.hypot(p.x - centre.x, p.y - centre.y) - radius) <= TOLERANCE)
    .map((p) => normaliseAngle(Math.atan2(p.y - centre.y, p.x - centre.x)));
  const cuts = dedupeAngles(angles.sort((a, b) => a - b));
  // A cut at 0 and another a hair short of 2π are the same place on the rim.
  if (cuts.length > 1 && Math.PI * 2 - cuts[cuts.length - 1]! + cuts[0]! < 1e-9) cuts.pop();
  return cuts;
}

/** The angles at which points sit strictly inside an arc's own sweep, in sweep order. */
function anglesBetween(
  points: readonly { x: number; y: number }[],
  centre: Vec2, radius: number, startAngle: number, endAngle: number,
): number[] {
  const sweep = endAngle - startAngle;
  if (Math.abs(sweep) <= TOLERANCE) return [];
  const found: number[] = [];
  for (const p of points) {
    if (Math.abs(Math.hypot(p.x - centre.x, p.y - centre.y) - radius) > TOLERANCE) continue;
    // How far round from the start, measured the way this arc turns.
    const offset = normaliseAngle((Math.atan2(p.y - centre.y, p.x - centre.x) - startAngle) * Math.sign(sweep));
    if (offset <= TOLERANCE || offset >= Math.abs(sweep) - TOLERANCE) continue;
    found.push(startAngle + offset * Math.sign(sweep));
  }
  const order = (a: number, b: number) => (sweep > 0 ? a - b : b - a);
  return dedupeAngles(found.sort(order));
}

/** 0..2π. */
function normaliseAngle(angle: number): number {
  let a = angle % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a;
}

/** Two points at the same place on a curve cut it once, not twice — a second cut at the
 *  same angle would be a zero-length segment and a self-loop in the graph. */
function dedupeAngles(sorted: readonly number[]): number[] {
  const out: number[] = [];
  for (const angle of sorted) {
    if (out.length === 0 || Math.abs(angle - out[out.length - 1]!) > 1e-9) out.push(angle);
  }
  return out;
}

function arcSegment(centre: Vec2, radius: number, startAngle: number, endAngle: number): ProfileSegment {
  const at = (angle: number) => ({ x: centre.x + radius * Math.cos(angle), y: centre.y + radius * Math.sin(angle) });
  return { kind: 'arc', centre, radius, from: at(startAngle), to: at(endAngle), startAngle, endAngle };
}

/** Direction a segment leaves its start point in. */
function startDirection(segment: Extract<ProfileSegment, { from: Vec2 }>): Vec2 {
  if (segment.kind === 'line') return normalise({ x: segment.to.x - segment.from.x, y: segment.to.y - segment.from.y });
  return arcTangent(segment, segment.from, arcTurnsLeft(segment));
}

/** Direction a segment arrives at its end point in. */
function endDirection(segment: Extract<ProfileSegment, { from: Vec2 }>): Vec2 {
  if (segment.kind === 'line') return normalise({ x: segment.to.x - segment.from.x, y: segment.to.y - segment.from.y });
  return arcTangent(segment, segment.to, arcTurnsLeft(segment));
}

/**
 * True when the arc sweeps counter-clockwise from its start to its end.
 *
 * Read from the raw angles. Folding the sweep into (−π, π] first made a major arc — say
 * 270° counter-clockwise — report as turning right, and the tangent it handed the face
 * tracer then pointed the wrong way at both of its ends.
 */
function arcTurnsLeft(segment: Extract<ProfileSegment, { kind: 'arc' }>): boolean {
  return segment.endAngle - segment.startAngle > 0;
}

function arcTangent(segment: Extract<ProfileSegment, { kind: 'arc' }>, at: Vec2, ccw: boolean): Vec2 {
  const radial = { x: at.x - segment.centre.x, y: at.y - segment.centre.y };
  return normalise(ccw ? { x: -radial.y, y: radial.x } : { x: radial.y, y: -radial.x });
}

const normalise = (v: Vec2): Vec2 => {
  const l = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / l, y: v.y / l };
};

/** Order loose segments end to end where they connect, for a readable gap report. */
function chainSegments(segments: Extract<ProfileSegment, { from: Vec2 }>[]): ProfileSegment[] {
  const remaining = [...segments];
  const out: ProfileSegment[] = [];
  while (remaining.length > 0) {
    let current = remaining.shift()!;
    out.push(current);
    for (;;) {
      const next = remaining.findIndex((s) => key(s.from) === key(current.to) || key(s.to) === key(current.to));
      if (next < 0) break;
      const [taken] = remaining.splice(next, 1);
      current = (key(taken!.from) === key(current.to) ? taken : reverse(taken!)) as Extract<ProfileSegment, { from: Vec2 }>;
      out.push(current);
    }
  }
  return out;
}

function reverse(segment: Extract<ProfileSegment, { from: Vec2 }>): ProfileSegment {
  if (segment.kind === 'line') return { kind: 'line', from: segment.to, to: segment.from };
  return {
    ...segment,
    from: segment.to,
    to: segment.from,
    startAngle: segment.endAngle,
    endAngle: segment.startAngle,
  };
}

/**
 * The outer boundary, by absolute area.
 *
 * Everything else is a hole. Nesting deeper than one level is not supported yet and
 * would need a containment test rather than a size comparison.
 */
export function outerLoop(loops: readonly ProfileLoop[]): ProfileLoop | null {
  if (loops.length === 0) return null;
  return loops.reduce((largest, loop) =>
    Math.abs(loop.signedArea) > Math.abs(largest.signedArea) ? loop : largest);
}

/**
 * Group loops into regions: each loop nobody contains is a face, and a loop inside
 * exactly one other is that face's hole. Two triangles sharing a corner are two
 * regions; a circle inside a rectangle is one region with a hole. Deeper nesting (an
 * island inside a hole) is not supported and the island is ignored.
 */
export function profileRegions(loops: readonly ProfileLoop[]): ProfileLoop[][] {
  const contains = (outer: ProfileLoop, inner: ProfileLoop) =>
    outer !== inner && pointInLoop(samplePoint(inner), outer);
  const parents = loops.map((loop) => loops.filter((other) => contains(other, loop)));
  const regions: ProfileLoop[][] = [];
  loops.forEach((loop, i) => { if (parents[i]!.length === 0) regions.push([loop]); });
  loops.forEach((loop, i) => {
    if (parents[i]!.length !== 1) return;
    const region = regions.find((r) => r[0] === parents[i]![0]);
    region?.push(loop);
  });
  return regions;
}

/** A point strictly inside the loop and just inside its BOUNDARY: for a polyline, just
 *  left of the first edge's midpoint (loops are counter-clockwise, so the interior is
 *  on the left); for a circle, just inside the rim.
 *
 *  Hugging the boundary is the whole point. A vertex would not do — two loops sharing a
 *  corner would each test as inside the other — and neither would a circle's centre:
 *  two CONCENTRIC circles both contain each other's centre, so each was the other's
 *  parent, neither was an outer loop, and a pair of rings reported that it enclosed no
 *  region at all. Sampled at the rim instead, the small circle is inside the big one
 *  and the big one is outside the small, which is what the eye says. */
function samplePoint(loop: ProfileLoop): Vec2 {
  const first = loop.segments[0]!;
  if (first.kind === 'circle') {
    return { x: first.centre.x + first.radius * (1 - 1e-6), y: first.centre.y };
  }
  const mid = { x: (first.from.x + first.to.x) / 2, y: (first.from.y + first.to.y) / 2 };
  const d = normalise({ x: first.to.x - first.from.x, y: first.to.y - first.from.y });
  const inset = 1e-4;
  return { x: mid.x - d.y * inset, y: mid.y + d.x * inset };
}

/** Even-odd ray test against a loop's polyline; arcs are treated by their chord, and a
 *  circle by its radius. Good enough to decide containment of one loop by another. */
function pointInLoop(p: Vec2, loop: ProfileLoop): boolean {
  const first = loop.segments[0]!;
  if (first.kind === 'circle') return Math.hypot(p.x - first.centre.x, p.y - first.centre.y) < first.radius;
  let inside = false;
  for (const segment of loop.segments) {
    if (segment.kind === 'circle') continue;
    const a = segment.from, b = segment.to;
    if ((a.y > p.y) !== (b.y > p.y)) {
      const x = a.x + ((p.y - a.y) * (b.x - a.x)) / (b.y - a.y);
      if (x > p.x) inside = !inside;
    }
  }
  return inside;
}
