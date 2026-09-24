import { beforeEach, describe, expect, it } from 'vitest';
import { Sketch } from './sketch.js';
import { SketchTools } from './tools.js';

/**
 * Trimming: cut a curve at the points on it, then take a piece away.
 *
 * This is what splitting a curve is FOR. The surviving piece keeps the curve's identity,
 * so the dimensions already placed on it go on applying — a radius on a circle goes on
 * measuring the arc it became.
 */
let sketch: Sketch;
beforeEach(() => { sketch = new Sketch({ kind: 'origin', plane: 'xy' }); });

const kinds = () => sketch.geometry.filter((e) => !e.external).map((e) => e.type).sort();
const arcs = () => sketch.geometry.filter((e) => e.type === 'arc');

/** A circle with two points on its rim, at the given angles. */
function circleWithPointsOn(angles: number[], radius = 10) {
  const centre = sketch.addPoint(0, 0);
  const circle = sketch.addCircle(centre, radius);
  const on = angles.map((a) => sketch.addPoint(radius * Math.cos(a), radius * Math.sin(a)));
  return { centre, circle, on };
}

describe('trimming a circle', () => {
  it('leaves the arc between the two points, keeping the circle s identity', () => {
    const { circle } = circleWithPointsOn([0, Math.PI]);
    // Click the top half.
    expect(sketch.trim(circle, { x: 0, y: 10 })).toBe(true);
    const remaining = sketch.entity(circle);
    expect(remaining?.type).toBe('arc');
    expect(arcs()).toHaveLength(1);
    // The bottom half survived: the arc runs the long way from 180 back round to 360.
    if (remaining?.type !== 'arc') throw new Error('not an arc');
    expect(remaining.radius).toBe(10);
    const mid = (remaining.startAngle + remaining.endAngle) / 2;
    expect(Math.sin(mid)).toBeLessThan(0);
  });

  it('keeps a radius dimension, which now measures the arc', () => {
    // The whole point of keeping the id. The solver routes a radius by what the entity
    // IS, so a circle_radius becomes an arc_radius with nothing else to change.
    const { circle } = circleWithPointsOn([0, Math.PI]);
    const radius = sketch.addConstraint({ type: 'radius', entity: circle, value: 10 });
    sketch.trim(circle, { x: 0, y: 10 });
    expect(sketch.entity(circle)?.type).toBe('arc');
    expect(sketch.constraints.find((c) => c.id === radius)).toMatchObject({
      type: 'radius', entity: circle, value: 10,
    });
  });

  it('leaves the remaining arc s sweep unconstrained', () => {
    // A circle never had a sweep, and inventing one would pin the trim in place.
    const { circle } = circleWithPointsOn([0, Math.PI]);
    sketch.trim(circle, { x: 0, y: 10 });
    expect(sketch.constraints.filter((c) => c.type === 'sweep')).toHaveLength(0);
  });

  it('makes two arcs when a piece is taken out of three', () => {
    const { circle } = circleWithPointsOn([0, (Math.PI * 2) / 3, (Math.PI * 4) / 3]);
    sketch.trim(circle, { x: 10, y: 0.01 }); // the piece starting at angle 0
    expect(arcs()).toHaveLength(2);
    // The circle is gone; both survivors are arcs, one of them still the original id.
    expect(sketch.geometry.some((e) => e.type === 'circle')).toBe(false);
    expect(sketch.entity(circle)?.type).toBe('arc');
  });

  it('removes a circle nothing touches, rather than doing nothing', () => {
    const centre = sketch.addPoint(0, 0);
    const circle = sketch.addCircle(centre, 10);
    expect(sketch.trim(circle, { x: 10, y: 0 })).toBe(true);
    expect(sketch.entity(circle)).toBeUndefined();
  });
});

describe('trimming a line', () => {
  it('shortens it to the piece that was left', () => {
    const a = sketch.addPoint(0, 0), b = sketch.addPoint(40, 0);
    const mid = sketch.addPoint(20, 0);
    const line = sketch.addLine(a, b);
    sketch.trim(line, { x: 30, y: 0 }); // the right half
    const remaining = sketch.entity(line);
    if (remaining?.type !== 'line') throw new Error('not a line');
    expect(new Set([remaining.p1, remaining.p2])).toEqual(new Set([a, mid]));
  });

  it('splits into two when the middle is taken out', () => {
    const a = sketch.addPoint(0, 0), b = sketch.addPoint(60, 0);
    sketch.addPoint(20, 0); sketch.addPoint(40, 0);
    const line = sketch.addLine(a, b);
    sketch.trim(line, { x: 30, y: 0 });
    expect(sketch.geometry.filter((e) => e.type === 'line' && !e.external)).toHaveLength(2);
  });
});

describe('trimming an arc', () => {
  it('drops the sweep dimension, because it measured a piece that is gone', () => {
    const centre = sketch.addPoint(0, 0);
    const start = sketch.addPoint(10, 0), end = sketch.addPoint(-10, 0);
    const mid = sketch.addPoint(0, 10);
    const arc = sketch.addArc(centre, 10, start, end, 0, Math.PI);
    sketch.addConstraint({ type: 'sweep', entity: arc, value: 180 });
    sketch.addConstraint({ type: 'radius', entity: arc, value: 10 });
    sketch.trim(arc, { x: 7.07, y: 7.07 }); // the first quarter
    expect(sketch.constraints.filter((c) => c.type === 'sweep')).toHaveLength(0);
    expect(sketch.constraints.filter((c) => c.type === 'radius')).toHaveLength(1);
    const remaining = sketch.entity(arc);
    if (remaining?.type !== 'arc') throw new Error('not an arc');
    expect(remaining.start).toBe(mid);
    expect(remaining.end).toBe(end);
  });
});

describe('the trim tool', () => {
  it('takes the piece under the click', () => {
    const tools = new SketchTools(sketch);
    const { circle } = circleWithPointsOn([0, Math.PI]);
    tools.setTool('trim');
    tools.click({ x: 0, y: 10 });
    expect(sketch.entity(circle)?.type).toBe('arc');
  });

  it('ignores a click nowhere near a curve', () => {
    const tools = new SketchTools(sketch);
    const { circle } = circleWithPointsOn([0, Math.PI]);
    tools.setTool('trim');
    tools.click({ x: 500, y: 500 });
    expect(sketch.entity(circle)?.type).toBe('circle');
    expect(kinds()).toContain('circle');
  });
});
