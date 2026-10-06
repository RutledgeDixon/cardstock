/**
 * Where a radial menu's slices go.
 *
 * Pure geometry, so it is tested without a browser. Every menu is a set of SLICES — pieces
 * of a band around a centre — placed by one of two rules:
 *
 * - `placeRing`: a right-click ring, or a group opened from one. Commands keep their
 *   declared compass directions, because a fixed direction is what turns a menu into
 *   muscle memory. Near an edge the whole ring slides inward rather than any slice
 *   changing direction.
 * - `placeArc`: a sidebar group. The old flyout list, bent into an arc round the button
 *   that opened it: one slice per row, top to bottom, a little apart, kept clear of the
 *   sidebar and the window edge.
 *
 * Angles are radians clockwise from straight up, as the sector numbers run.
 */

export interface Point { readonly x: number; readonly y: number }
/** The area slices must stay inside, in page pixels. */
export interface Bounds { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }

/** One slice: the part of the band between two radii and two angles. */
export interface Slice {
  readonly centre: Point;
  readonly inner: number;
  readonly outer: number;
  readonly from: number;
  readonly to: number;
}

/** The right-click ring's band, as it has always been. */
export const RING = { inner: 48, outer: 116 } as const;
/** Half the gap between neighbouring ring slices, in radians. */
export const RING_GAP = 0.03;

/**
 * The sidebar arc: the old flyout list, gently curved. Its centre sits far out to the
 * RIGHT of the button, behind the sidebar, so the rows hug the strip the way the list
 * did and only bend a little at the ends; a centre on the button itself curved them so
 * hard that the lower rows tilted forty-five degrees.
 */
export const ARC = { radius: 260, thickness: 132, row: 34, gap: 5 } as const;

export const along = (centre: Point, radius: number, angle: number): Point => ({
  x: centre.x + radius * Math.sin(angle),
  y: centre.y - radius * Math.cos(angle),
});

/** Where a slice's icon and label go: the middle of the band, halfway round. */
export const sliceMiddle = (s: Slice): Point => along(s.centre, (s.inner + s.outer) / 2, (s.from + s.to) / 2);

/** The box a slice occupies, from points along both of its edges. */
export function sliceBox(s: Slice): Bounds {
  const points: Point[] = [];
  for (let i = 0; i <= 12; i++) {
    const angle = s.from + ((s.to - s.from) * i) / 12;
    points.push(along(s.centre, s.inner, angle), along(s.centre, s.outer, angle));
  }
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

/**
 * A ring of slices in fixed directions round `origin`, slid inward if any would cross
 * the bounds. `sectors` are the directions in use, out of `count` round the circle.
 */
export function placeRing(
  origin: Point, sectors: readonly number[], count: number, bounds: Bounds,
  band: { inner: number; outer: number } = RING,
): { centre: Point; slices: Slice[] } {
  const span = (Math.PI * 2) / count;
  const at = (centre: Point) => sectors.map((sector): Slice => ({
    centre, inner: band.inner, outer: band.outer,
    from: sector * span - span / 2 + RING_GAP, to: sector * span + span / 2 - RING_GAP,
  }));

  // The used slices' extent relative to the centre decides how far the ring must move.
  const boxes = at({ x: 0, y: 0 }).map(sliceBox);
  if (boxes.length === 0) return { centre: origin, slices: [] };
  const left = Math.min(...boxes.map((b) => b.left)), right = Math.max(...boxes.map((b) => b.right));
  const top = Math.min(...boxes.map((b) => b.top)), bottom = Math.max(...boxes.map((b) => b.bottom));
  const clamp = (value: number, low: number, high: number) =>
    (low > high ? (low + high) / 2 : Math.min(Math.max(value, low), high));
  const centre = {
    x: clamp(origin.x, bounds.left - left, bounds.right - right),
    y: clamp(origin.y, bounds.top - top, bounds.bottom - bottom),
  };
  return { centre, slices: at(centre) };
}

/**
 * A sidebar group: its rows as slices of a gentle arc beside the button.
 *
 * The rows' inner edge runs down the sidebar's edge; the arc is centred on the button's
 * height and turned up or down as far as the window needs. Read top to bottom, as the
 * list it replaces was.
 */
export function placeArc(origin: Point, count: number, bounds: Bounds): Slice[] {
  if (count === 0) return [];
  const WEST = Math.PI * 1.5;
  const inner = ARC.radius, outer = inner + ARC.thickness;
  const middle = (inner + outer) / 2;
  const rowAngle = ARC.row / middle;
  const gapAngle = ARC.gap / middle;
  const total = count * rowAngle + (count - 1) * gapAngle;
  const rows = (start: number, centre: Point) => Array.from({ length: count }, (_, i): Slice => {
    // Top to bottom is decreasing angle on the left side: north-west first.
    const to = start + total - i * (rowAngle + gapAngle);
    return { centre, inner, outer, from: to - rowAngle, to };
  });

  // Height first, which does not depend on how far right the centre sits: centred on
  // the button, slid down or up only as far as the window edge needs.
  const extent = (start: number) => {
    const boxes = rows(start, { x: 0, y: origin.y }).map(sliceBox);
    return { top: Math.min(...boxes.map((b) => b.top)), bottom: Math.max(...boxes.map((b) => b.bottom)) };
  };
  let start = WEST - total / 2;
  const step = Math.PI / 1440;
  // Rows above the window: turn the arc down (smaller angles); below it: turn it up.
  for (let guard = 0; guard < 2000 && extent(start).top < bounds.top; guard++) start -= step;
  for (let guard = 0; guard < 2000 && extent(start).bottom > bounds.bottom; guard++) start += step;
  const { top, bottom } = extent(start);
  if (top < bounds.top - 1e-6 || bottom > bounds.bottom + 1e-6 || start < Math.PI || start + total > Math.PI * 2) {
    // A window too short for the list: a ring in the open instead.
    const open = { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2 };
    return placeRing(open, Array.from({ length: count }, (_, i) => i), Math.max(count, 8), bounds).slices;
  }

  // Then across: the centre goes far enough right that the row nearest the sidebar —
  // an end row, since the arc bends back round the button — just clears it.
  const reach = Math.max(...rows(start, { x: 0, y: origin.y }).map((r) => sliceBox(r).right));
  return rows(start, { x: bounds.right - 2 - reach, y: origin.y });
}
