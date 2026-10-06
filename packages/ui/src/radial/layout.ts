/**
 * Where a radial menu's buttons go.
 *
 * Pure geometry, so it is tested without a browser. Every menu in the app — a right-click
 * ring, a group opened from it, a sidebar group — is placed by one of two rules here:
 *
 * - `placeSectors`: the right-click ring. Commands keep their declared compass
 *   directions, because a fixed direction is what turns a menu into muscle memory. If the
 *   ring would cross the edge of the screen, the whole ring slides inward rather than
 *   any button moving out of its direction.
 * - `placeFan`: groups. The buttons spread round the point they came from, over as much
 *   of the circle as stays on screen: a full ring in open space, an arc opening to the
 *   left from the sidebar, a quarter in a corner — pushed further out when a narrow arc
 *   would crowd them.
 *
 * Either way, no button is ever placed off screen.
 */

export interface Point { readonly x: number; readonly y: number }
export interface Size { readonly width: number; readonly height: number }
/** The area buttons must stay inside, in page pixels. */
export interface Bounds { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }

export interface Placement {
  /** The point the ring is arranged around — the origin, unless it had to move. */
  readonly centre: Point;
  /** Button centres, in the order the items were given. */
  readonly positions: readonly Point[];
}

/** Gap kept between neighbouring buttons. */
const GAP = 8;
/** Closest a ring's buttons come to its centre; leaves room for the cursor and a label. */
const MIN_RADIUS = 72;
const MAX_RADIUS = 520;
const STEP = 4;

/**
 * A direction measured clockwise from straight up, as the sector numbers run.
 *
 * The ring may be an ellipse: screens are wider than tall, so a crowded ring keeps its
 * width and gives up height — fifteen buttons in a circle need 650px top to bottom,
 * more than a laptop window has, but fit easily squashed.
 */
const along = (centre: Point, radius: number, angle: number, squash = radius): Point => ({
  x: centre.x + radius * Math.sin(angle),
  y: centre.y - Math.min(radius, squash) * Math.cos(angle),
});

/** The tallest vertical radius that keeps a button inside the bounds. */
const tallest = (size: Size, bounds: Bounds) => Math.max(0, (bounds.bottom - bounds.top - size.height) / 2);

const inside = (p: Point, size: Size, b: Bounds): boolean =>
  p.x - size.width / 2 >= b.left && p.x + size.width / 2 <= b.right
  && p.y - size.height / 2 >= b.top && p.y + size.height / 2 <= b.bottom;

/** True when no two buttons overlap, gap included. */
function apart(points: readonly Point[], size: Size): boolean {
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const a = points[i]!, b = points[j]!;
      if (Math.abs(a.x - b.x) < size.width + GAP && Math.abs(a.y - b.y) < size.height + GAP) return false;
    }
  }
  return true;
}

/**
 * The fixed-direction ring.
 *
 * The radius is set by ALL the sectors, not just the filled ones, so a ring is the same
 * size whatever it holds and a direction always means the same distance too.
 */
export function placeSectors(
  origin: Point, sectors: readonly number[], sectorCount: number, size: Size, bounds: Bounds,
): Placement {
  const angleOf = (sector: number) => (sector * Math.PI * 2) / sectorCount;
  const squash = tallest(size, bounds);
  let radius = MIN_RADIUS;
  const all = Array.from({ length: sectorCount }, (_, i) => i);
  while (radius < MAX_RADIUS && !apart(all.map((s) => along({ x: 0, y: 0 }, radius, angleOf(s), squash)), size)) {
    radius += STEP;
  }

  // Slide the centre the least distance that brings every used button inside.
  const offsets = sectors.map((s) => along({ x: 0, y: 0 }, radius, angleOf(s), squash));
  const clampAxis = (value: number, low: number, high: number) =>
    (low > high ? (low + high) / 2 : Math.min(Math.max(value, low), high));
  const xs = offsets.map((o) => o.x), ys = offsets.map((o) => o.y);
  const centre = offsets.length === 0 ? origin : {
    x: clampAxis(origin.x, bounds.left + size.width / 2 - Math.min(...xs), bounds.right - size.width / 2 - Math.max(...xs)),
    y: clampAxis(origin.y, bounds.top + size.height / 2 - Math.min(...ys), bounds.bottom - size.height / 2 - Math.max(...ys)),
  };
  return { centre, positions: offsets.map((o) => ({ x: centre.x + o.x, y: centre.y + o.y })) };
}

/** Degrees of the circle sampled when looking for the on-screen arc. */
const SAMPLES = 360;

/**
 * The longest run of directions, at this radius, in which a button stays inside the
 * bounds — as [start, span] in radians, clockwise from up. Null when there is none.
 */
function openArc(origin: Point, radius: number, squash: number, size: Size, bounds: Bounds): [number, number] | null {
  const ok = Array.from({ length: SAMPLES }, (_, i) =>
    inside(along(origin, radius, (i / SAMPLES) * Math.PI * 2, squash), size, bounds));
  if (ok.every(Boolean)) return [0, Math.PI * 2];
  if (!ok.some(Boolean)) return null;
  // Start counting just after a blocked direction, so a run that wraps past "up" is
  // still measured as one run.
  const first = ok.indexOf(false);
  let best: [number, number] = [0, 0];
  let runStart = -1;
  for (let k = 1; k <= SAMPLES; k++) {
    const i = (first + k) % SAMPLES;
    if (ok[i]) {
      if (runStart < 0) runStart = i;
      const length = ((i - runStart + SAMPLES) % SAMPLES) + 1;
      if (length > best[1]) best = [runStart, length];
    } else {
      runStart = -1;
    }
  }
  const step = (Math.PI * 2) / SAMPLES;
  // A sample's width of margin each side: the run's ends are the last directions that
  // fit, not comfortably inside.
  return [(best[0] + 1) * step, Math.max(0, best[1] - 2) * step];
}

/** The tightest arrangement around one centre, or null when none fits. */
function ringAround(centre: Point, count: number, size: Size, bounds: Bounds): { radius: number; positions: Point[] } | null {
  const squash = tallest(size, bounds);
  for (let radius = MIN_RADIUS; radius <= MAX_RADIUS; radius += STEP) {
    const arc = openArc(centre, radius, squash, size, bounds);
    if (!arc) continue;
    const [start, span] = arc;
    const full = span >= Math.PI * 2 - 1e-9;
    let angles: number[];
    if (full) {
      angles = Array.from({ length: count }, (_, i) => (i * Math.PI * 2) / count);
    } else if (count === 1) {
      angles = [start + span / 2];
    } else {
      // Spread across the arc, but no wider than an evenly spaced full ring would be:
      // two buttons should sit side by side, not at opposite ends of a half circle.
      const step = Math.min(span / (count - 1), (Math.PI * 2) / count);
      const middle = start + span / 2;
      angles = Array.from({ length: count }, (_, i) => middle + (i - (count - 1) / 2) * step);
    }
    const points = angles.map((a) => along(centre, radius, a, squash));
    if (!points.every((p) => inside(p, size, bounds)) || !apart(points, size)) continue;
    // An arc reads top to bottom (then left to right), whichever way round it runs.
    if (!full) points.sort((a, b) => (a.y - b.y) || (a.x - b.x));
    return { radius, positions: points };
  }
  return null;
}

/**
 * A group's buttons around the point it opened from.
 *
 * In open space they make a full ring starting straight up; against an edge they share
 * the arc that stays on screen, read top to bottom. The radius grows until they fit
 * without overlapping.
 *
 * A point right at an edge — a sidebar button — has at most half a circle to use, and
 * near a corner barely a quarter, so a ring centred exactly there grows huge before
 * everything fits. So the ring may centre a little way in from the point instead,
 * toward the middle of the screen, when that makes it much tighter. The buttons still
 * pop out of the point itself; only where they settle moves. Should nothing fit even
 * so — a tiny window — they ring the middle of the screen.
 */
export function placeFan(origin: Point, count: number, size: Size, bounds: Bounds): Placement {
  if (count === 0) return { centre: origin, positions: [] };
  const middle = { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2 };
  let best: { centre: Point; positions: Point[]; score: number } | null = null;
  for (const t of [0, 0.1, 0.2, 0.3, 0.45, 0.6]) {
    const centre = { x: origin.x + (middle.x - origin.x) * t, y: origin.y + (middle.y - origin.y) * t };
    const ring = ringAround(centre, count, size, bounds);
    if (!ring) continue;
    // Moving costs: a menu should stay near what opened it unless that is much tighter.
    const score = ring.radius + 0.3 * Math.hypot(centre.x - origin.x, centre.y - origin.y);
    if (!best || score < best.score) best = { centre, positions: ring.positions, score };
  }
  if (best) return { centre: best.centre, positions: best.positions };
  return placeSectors(middle, Array.from({ length: count }, (_, i) => i), count, size, bounds);
}
