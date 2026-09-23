import { beforeAll, describe, expect, it } from 'vitest';
import { Sketch } from '@cardstock/document';
import { PlaneGcsSolver } from '@cardstock/kernel';

/**
 * What a drag is allowed to move.
 *
 * Dragging one point used to translate everything connected to it — every point the
 * constraint graph could reach — as the solver's starting guess, and the solver then
 * settled on the nearest solution to THAT. Anything the drag did not actually
 * constrain kept the offset: pulling the end of an arc on one side of a part slid the
 * far side sideways, which is the shape of the bug this file exists to prevent.
 */
let solver: PlaneGcsSolver;
beforeAll(async () => { solver = await PlaneGcsSolver.create(); }, 60_000);

const P = (sketch: Sketch, id: string) => sketch.entity(id) as { x: number; y: number };

/**
 * The clip profile from the screenshot, simplified to what matters: a left vertical
 * side, two parallel rails running right, and an arc closing the right-hand end.
 *
 *   tl ────────────── ts ╮
 *   │                    │  arc
 *   bl ────────────── bs ╯
 */
function railsAndArc() {
  const sketch = new Sketch({ kind: 'origin', plane: 'xy' });
  const bl = sketch.addPoint(0, 0);
  const tl = sketch.addPoint(0, 20);
  const bs = sketch.addPoint(60, 0);
  const ts = sketch.addPoint(60, 20);
  const centre = sketch.addPoint(60, 10);

  const left = sketch.addLine(bl, tl);
  const bottom = sketch.addLine(bl, bs);
  const top = sketch.addLine(tl, ts);
  const axis = sketch.addLine(bs, ts, true);
  const arc = sketch.addArc(centre, 10, bs, ts, -Math.PI / 2, Math.PI / 2, axis);

  sketch.addConstraint({ type: 'vertical', line: left });
  sketch.addConstraint({ type: 'horizontal', line: bottom });
  sketch.addConstraint({ type: 'parallel', a: bottom, b: top });
  sketch.addConstraint({ type: 'arcAngle', entity: arc, axis, value: 180 });
  // The arc caps the rails square-on, as the tool draws it.
  sketch.addConstraint({ type: 'vertical', line: axis });
  // The left side is where it is; without this the whole thing is free to wander and
  // every drag is a translation.
  sketch.addConstraint({ type: 'lockX', point: bl, value: 0 });
  sketch.addConstraint({ type: 'lockY', point: bl, value: 0 });
  sketch.addConstraint({ type: 'distance', a: bl, b: tl, value: 20 });
  return { sketch, bl, tl, bs, ts, centre, top, bottom };
}

describe('dragging an arc end', () => {
  it('lengthens the rails without moving the far side of the sketch', async () => {
    const { sketch, bl, tl, bs, ts } = railsAndArc();
    await sketch.solve(solver, {});
    const before = { bl: { ...P(sketch, bl) }, tl: { ...P(sketch, tl) } };

    // Pull the arc's top end 15 mm to the right, as the pointer would.
    await sketch.solve(solver, {}, { point: ts, x: 75, y: 20 });

    // The thing that was dragged went where it was pulled...
    expect(P(sketch, ts).x).toBeCloseTo(75, 3);
    // ...the other end of the arc came with it, because the arc's ends are its axis...
    expect(P(sketch, bs).x).toBeCloseTo(75, 3);
    // ...and the left-hand side did not move at all. This is the regression: it used
    // to slide by the full drag distance.
    expect(P(sketch, bl)).toMatchObject({ x: expect.closeTo(before.bl.x, 6), y: expect.closeTo(before.bl.y, 6) });
    expect(P(sketch, tl)).toMatchObject({ x: expect.closeTo(before.tl.x, 6), y: expect.closeTo(before.tl.y, 6) });
  });

  it('follows the pointer only as far as the constraints allow', async () => {
    // Dragging the same end straight up cannot lift it: the rails are parallel and the
    // left side fixes the height. It should track in x and stay put in y rather than
    // dragging the sketch out of shape.
    const { sketch, ts, bl } = railsAndArc();
    await sketch.solve(solver, {});
    const height = P(sketch, ts).y;

    await sketch.solve(solver, {}, { point: ts, x: 70, y: 45 });

    expect(P(sketch, ts).y).toBeCloseTo(height, 3);
    expect(P(sketch, bl)).toMatchObject({ x: expect.closeTo(0, 6), y: expect.closeTo(0, 6) });
  });
});

describe('a sketch with no freedom left', () => {
  it('does not move at all', async () => {
    const sketch = new Sketch({ kind: 'origin', plane: 'xy' });
    const a = sketch.addPoint(0, 0);
    const b = sketch.addPoint(30, 0);
    const c = sketch.addPoint(30, 20);
    const ab = sketch.addLine(a, b);
    const bc = sketch.addLine(b, c);
    sketch.addConstraint({ type: 'horizontal', line: ab });
    sketch.addConstraint({ type: 'vertical', line: bc });
    sketch.addConstraint({ type: 'distance', a, b, value: 30 });
    sketch.addConstraint({ type: 'distance', a: b, b: c, value: 20 });
    sketch.addConstraint({ type: 'lockX', point: a, value: 0 });
    sketch.addConstraint({ type: 'lockY', point: a, value: 0 });
    await sketch.solve(solver, {});
    expect(sketch.dof).toBe(0);
    const before = [a, b, c].map((id) => ({ ...P(sketch, id) }));

    await sketch.solve(solver, {}, { point: c, x: 200, y: 200 });

    for (const [i, id] of [a, b, c].entries()) {
      expect(P(sketch, id).x).toBeCloseTo(before[i]!.x, 6);
      expect(P(sketch, id).y).toBeCloseTo(before[i]!.y, 6);
    }
  });
});

describe('a sketch that is rigid but not tied down', () => {
  it('moves as a whole, following the pointer exactly', async () => {
    // Every internal rule, no position: the classic "one degree of freedom is the
    // whole sketch" case. Dragging any point must translate it, not deform it.
    const sketch = new Sketch({ kind: 'origin', plane: 'xy' });
    const a = sketch.addPoint(0, 0);
    const b = sketch.addPoint(30, 0);
    const c = sketch.addPoint(30, 20);
    const ab = sketch.addLine(a, b);
    const bc = sketch.addLine(b, c);
    sketch.addConstraint({ type: 'horizontal', line: ab });
    sketch.addConstraint({ type: 'vertical', line: bc });
    sketch.addConstraint({ type: 'distance', a, b, value: 30 });
    sketch.addConstraint({ type: 'distance', a: b, b: c, value: 20 });
    await sketch.solve(solver, {});

    await sketch.solve(solver, {}, { point: a, x: 5, y: 7 });

    expect(P(sketch, a)).toMatchObject({ x: expect.closeTo(5, 3), y: expect.closeTo(7, 3) });
    // Rigid: the other corners kept their offsets exactly.
    expect(P(sketch, b)).toMatchObject({ x: expect.closeTo(35, 3), y: expect.closeTo(7, 3) });
    expect(P(sketch, c)).toMatchObject({ x: expect.closeTo(35, 3), y: expect.closeTo(27, 3) });
  });
});
