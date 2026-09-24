import type { ProfileLoopSpec, ProfileSegment, Vec2 } from '@cardstock/types';
import { profileRegions, signedArea } from '../sketch/profile.js';
import { FACES, type FaceData } from './font-data.js';

/**
 * Text as geometry: a string becomes closed loops a kernel can make faces from.
 *
 * Glyph outlines are quadratic curves in font units (see font-data.ts). Here they are
 * laid out along a baseline, scaled to millimetres, flattened to polylines, and grouped
 * into regions — a letter's counter is a hole in it, while the dot on an `i` is a
 * separate region, and only containment can tell those apart. That grouping is the same
 * one the sketcher uses, because "which loop is inside which" is the same question.
 */

export const TEXT_FONTS = Object.keys(FACES) as readonly (keyof typeof FACES)[];

export const fontLabel = (key: string): string => FACES[key]?.name ?? key;

/** How finely curves are flattened, in millimetres of chord error. Well under a nozzle. */
const FLATNESS = 0.02;

export interface TextLayout {
  /** Each region: outer loop first, then its holes. */
  readonly regions: readonly (readonly ProfileLoopSpec[])[];
  /** The text's extent in millimetres, for centring and for reporting. */
  readonly width: number;
  readonly height: number;
}

/**
 * Lay a string out, centred on the origin.
 *
 * Centred because the caller puts it on a face's centroid: text that grew rightwards
 * from there would sit off the side of anything it was applied to.
 */
export function textLayout(text: string, font: string, size: number): TextLayout {
  const face = FACES[font] ?? FACES[TEXT_FONTS[0]!]!;
  if (size <= 0) throw new Error('text size must be positive');

  const scale = size / face.unitsPerEm;
  const lineHeight = (face.ascender - face.descender) * scale;
  const lines = text.split('\n');

  // Advance widths first: every line has to know its own width to be centred.
  const widths = lines.map((line) => [...line].reduce(
    (x, ch) => x + (glyph(face, ch)?.advance ?? 0) * scale, 0,
  ));
  const width = Math.max(0, ...widths);
  const height = lines.length * lineHeight;

  const loops: ProfileLoopSpec[] = [];
  lines.forEach((line, row) => {
    // The baseline of each row, measured down from the top of the block, then shifted
    // so the whole block straddles the origin.
    const baseline = height / 2 - face.ascender * scale - row * lineHeight;
    let x = -widths[row]! / 2;
    for (const ch of line) {
      const g = glyph(face, ch);
      if (!g) continue;
      for (const contour of g.contours) {
        const points = flatten(contour, scale, x, baseline);
        if (points.length >= 3) loops.push(loopOf(points));
      }
      x += g.advance * scale;
    }
  });

  if (loops.length === 0) return { regions: [], width, height };

  // Wind every loop the same way before grouping: containment is tested from a point
  // just inside a loop's boundary, on the left, which is only inside at all when the
  // loop runs counter-clockwise.
  const wound = loops.map((loop) => (loop.signedArea < 0 ? reverse(loop) : loop));
  const regions = profileRegions(
    wound.map((loop) => ({ segments: loop.segments, closed: true, signedArea: loop.signedArea })),
  ).map((region) => region.map((loop) => ({ segments: loop.segments, signedArea: loop.signedArea })));

  return { regions, width, height };
}

/** A glyph, or the fallback for anything outside printable ASCII. */
function glyph(face: FaceData, ch: string) {
  return face.glyphs[ch] ?? (ch.trim() === '' ? face.glyphs[' '] : face.glyphs['?']);
}

/**
 * One TrueType contour as a polyline.
 *
 * Points are on-curve or quadratic control points, and two consecutive controls imply an
 * on-curve point midway between them — the format's way of saving a point on a smooth
 * join. Walking that out is most of the work; the rest is subdividing each quadratic
 * finely enough that the curve reads as a curve at the size asked for.
 */
function flatten(contour: readonly number[], scale: number, dx: number, dy: number): Vec2[] {
  const count = contour.length / 3;
  if (count === 0) return [];
  const at = (i: number): Vec2 & { on: boolean } => {
    const k = ((i % count) + count) % count;
    return { x: contour[k * 3]! * scale + dx, y: contour[k * 3 + 1]! * scale + dy, on: contour[k * 3 + 2] === 1 };
  };
  const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  // Start on the outline: either the first on-curve point, or the midpoint implied
  // between the last and first controls when the contour is all curve.
  let start = -1;
  for (let i = 0; i < count; i++) if (at(i).on) { start = i; break; }
  const first = start >= 0 ? at(start) : mid(at(count - 1), at(0));
  const points: Vec2[] = [{ x: first.x, y: first.y }];
  const from = start >= 0 ? start : 0;

  let current: Vec2 = points[0]!;
  for (let step = 1; step <= count; step++) {
    const point = at(from + step);
    if (point.on) {
      points.push({ x: point.x, y: point.y });
      current = point;
      continue;
    }
    // A control point: the curve ends at the next on-curve point, or at the midpoint
    // to the following control when two run together.
    const next = at(from + step + 1);
    const end = next.on ? { x: next.x, y: next.y } : mid(point, next);
    for (const p of quadratic(current, point, end)) points.push(p);
    current = end;
    if (next.on) step++;
  }
  // The walk returns to where it began; the loop closes implicitly.
  while (points.length > 1 && near(points[0]!, points[points.length - 1]!)) points.pop();
  return points;
}

/** A quadratic Bezier as line segments, subdivided to FLATNESS. */
function quadratic(from: Vec2, control: Vec2, to: Vec2): Vec2[] {
  // Chord error of a quadratic is at most a quarter of the control point's offset from
  // the chord's midpoint, which gives the step count directly.
  const sag = Math.hypot(control.x - (from.x + to.x) / 2, control.y - (from.y + to.y) / 2) / 2;
  const steps = Math.max(2, Math.min(24, Math.ceil(Math.sqrt(sag / FLATNESS) * 2)));
  const out: Vec2[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, u = 1 - t;
    out.push({
      x: u * u * from.x + 2 * u * t * control.x + t * t * to.x,
      y: u * u * from.y + 2 * u * t * control.y + t * t * to.y,
    });
  }
  return out;
}

const near = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y) < 1e-9;

function loopOf(points: readonly Vec2[]): ProfileLoopSpec {
  const segments: ProfileSegment[] = points.map((from, i) => ({
    kind: 'line' as const, from, to: points[(i + 1) % points.length]!,
  }));
  return { segments, signedArea: signedArea(segments) };
}

function reverse(loop: ProfileLoopSpec): ProfileLoopSpec {
  const segments = [...loop.segments].reverse().map((s) => {
    if (s.kind !== 'line') return s;
    return { kind: 'line' as const, from: s.to, to: s.from };
  });
  return { segments, signedArea: -loop.signedArea };
}
