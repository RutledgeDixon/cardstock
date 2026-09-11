import { describe, expect, it } from 'vitest';
import { DIMENSION_STYLE, angle, pointToLine, pointToPoint, radius } from './dimension-lines.js';

const near = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y) < 1e-9;

describe('dimension drawings', () => {
  it('a point-to-point dimension is offset away from the sketch, with extension lines', () => {
    const d = pointToPoint({ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 20, y: 10 }, 1);
    // Dimension line runs parallel, 26 px below (away from the centre above).
    const dim = d.segments[0]!;
    expect(dim.from.y).toBeCloseTo(-DIMENSION_STYLE.offset);
    expect(dim.to.y).toBeCloseTo(-DIMENSION_STYLE.offset);
    expect(d.anchor).toEqual({ x: 20, y: -DIMENSION_STYLE.offset });
    // Two arrowheads (two strokes each) and two extension lines.
    expect(d.segments).toHaveLength(1 + 4 + 2);
    const extensions = d.segments.slice(5);
    expect(extensions[0]!.from.y).toBeCloseTo(-DIMENSION_STYLE.gap);
    expect(extensions[0]!.to.y).toBeCloseTo(-DIMENSION_STYLE.offset - DIMENSION_STYLE.overshoot);
  });

  it('a point-to-line dimension is perpendicular and extends the line when needed', () => {
    const on = pointToLine({ x: 20, y: 15 }, { x: 0, y: 0 }, { x: 40, y: 0 }, 1);
    expect(near(on.segments[0]!.from, { x: 20, y: 0 })).toBe(true);
    expect(near(on.segments[0]!.to, { x: 20, y: 15 })).toBe(true);
    expect(on.segments).toHaveLength(5); // line + two arrowheads, no extension

    const off = pointToLine({ x: 60, y: 15 }, { x: 0, y: 0 }, { x: 40, y: 0 }, 1);
    expect(off.segments).toHaveLength(6);
    const extension = off.segments[5]!;
    expect(near(extension.from, { x: 40, y: 0 })).toBe(true);
    expect(extension.to.x).toBeCloseTo(60 + DIMENSION_STYLE.overshoot);
  });

  it('a radius leader passes through the rim and puts the value outside', () => {
    const d = radius({ x: 0, y: 0 }, 10, 1);
    expect(Math.hypot(d.anchor.x, d.anchor.y)).toBeGreaterThan(10);
    expect(near(d.segments[0]!.from, { x: 0, y: 0 })).toBe(true);
  });

  it('an angle arcs about the intersection, on the side of the lines as drawn', () => {
    const d = angle({ a: { x: 0, y: 0 }, b: { x: 30, y: 0 } }, { a: { x: 0, y: 0 }, b: { x: 0, y: 30 } }, 1);
    expect(d.segments.length).toBeGreaterThan(16);
    expect(d.anchor.x).toBeGreaterThan(0);
    expect(d.anchor.y).toBeGreaterThan(0);
  });

  it('scales with the pixel size so the drawing stays the same size on screen', () => {
    const fine = pointToPoint({ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 20, y: 10 }, 0.1);
    expect(fine.segments[0]!.from.y).toBeCloseTo(-DIMENSION_STYLE.offset * 0.1);
  });
});
