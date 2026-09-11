import { beforeEach, describe, expect, it } from 'vitest';
import { Sketch } from './sketch.js';
import { MockSolver } from './mock-solver.js';

let sketch: Sketch;
let solver: MockSolver;

beforeEach(() => {
  sketch = new Sketch({ kind: 'origin', plane: 'xy' });
  solver = new MockSolver();
});

/** Four corners and four lines, as a rectangle would be drawn. */
function rectangle(s: Sketch) {
  const p = [s.addPoint(0, 0, { fixed: true }), s.addPoint(40, 0), s.addPoint(40, 20), s.addPoint(0, 20)];
  const l = [
    s.addLine(p[0]!, p[1]!), s.addLine(p[1]!, p[2]!),
    s.addLine(p[2]!, p[3]!), s.addLine(p[3]!, p[0]!),
  ];
  return { p, l };
}

describe('building geometry', () => {
  it('mints unique ids', () => {
    const a = sketch.addPoint(0, 0);
    const b = sketch.addPoint(1, 1);
    expect(a).not.toBe(b);
    expect(sketch.geometry).toHaveLength(2);
  });

  it('refuses a line whose ends are not points', () => {
    const p = sketch.addPoint(0, 0);
    const line = sketch.addLine(p, sketch.addPoint(1, 0));
    // A line is not a point, so it cannot be a line's endpoint.
    expect(() => sketch.addLine(p, line)).toThrow(/is not a point/);
    expect(() => sketch.addLine(p, 'ghost')).toThrow(/is not a point/);
  });

  it('refuses a degenerate circle', () => {
    const c = sketch.addPoint(0, 0);
    expect(() => sketch.addCircle(c, 0)).toThrow(/must be positive/);
    expect(() => sketch.addCircle(c, -5)).toThrow(/must be positive/);
  });

  it('marks construction geometry', () => {
    const a = sketch.addPoint(0, 0);
    const b = sketch.addPoint(10, 0);
    const line = sketch.addLine(a, b, true);
    expect(sketch.entity(line)).toMatchObject({ construction: true });
  });
});

describe('constraints', () => {
  it('refuses a constraint referencing something that is not there', () => {
    const p = sketch.addPoint(0, 0);
    expect(() => sketch.addConstraint({ type: 'coincident', a: p, b: 'ghost' }))
      .toThrow(/references unknown "ghost"/);
  });

  it('reports the parameter names its dimensions reference', () => {
    const { p, l } = rectangle(sketch);
    sketch.addConstraint({ type: 'distance', a: p[0]!, b: p[1]!, value: 'width' });
    sketch.addConstraint({ type: 'distance', a: p[1]!, b: p[2]!, value: 20 });
    sketch.addConstraint({ type: 'horizontal', line: l[0]! });
    // Only named ones: a literal has nothing to look up.
    expect(sketch.referencedParameters()).toEqual(['width']);
  });
});

describe('deletion cascades', () => {
  it('removes constraints that referenced the deleted entity', () => {
    // A constraint pointing at something deleted makes the WHOLE sketch fail to solve,
    // with a message about geometry that is no longer on screen.
    const { p, l } = rectangle(sketch);
    sketch.addConstraint({ type: 'horizontal', line: l[0]! });
    sketch.addConstraint({ type: 'vertical', line: l[1]! });
    expect(sketch.constraints).toHaveLength(2);

    sketch.remove(l[0]!);
    expect(sketch.constraints.map((c) => c.type)).toEqual(['vertical']);
    expect(sketch.entity(l[0]!)).toBeUndefined();
    void p;
  });

  it('cleans up points left behind, but keeps shared and fixed ones', () => {
    const { p, l } = rectangle(sketch);
    sketch.remove(l[0]!); // p0-p1; p0 is fixed, p1 is still used by l1
    expect(sketch.entity(p[0]!)).toBeDefined(); // fixed: the origin stays
    expect(sketch.entity(p[1]!)).toBeDefined(); // still an endpoint of another line
  });

  it('drops a point once nothing uses it', () => {
    const a = sketch.addPoint(0, 0);
    const b = sketch.addPoint(10, 0);
    const line = sketch.addLine(a, b);
    sketch.remove(line);
    expect(sketch.geometry).toHaveLength(0);
  });

  it('reports whether anything was removed', () => {
    expect(sketch.remove('ghost')).toBe(false);
  });
});

describe('solving', () => {
  it('applies solved positions back onto the geometry', async () => {
    const a = sketch.addPoint(0, 0);
    solver.status = 'solved';
    await sketch.solve(solver, {}, { point: a, x: 12, y: 7 });
    expect(sketch.entity(a)).toMatchObject({ x: 12, y: 7 });
  });

  it('leaves geometry alone when the solve fails', async () => {
    // A failed solve must not scramble the sketch: the user still has to see and fix it.
    const a = sketch.addPoint(3, 4);
    solver.conflicting = ['k1'];
    await sketch.solve(solver);
    expect(sketch.entity(a)).toMatchObject({ x: 3, y: 4 });
  });

  it('passes parameters through to the solver', async () => {
    rectangle(sketch);
    await sketch.solve(solver, { width: 55 });
    expect(solver.requests[0]!.parameters).toEqual({ width: 55 });
  });

  it('reports status from degrees of freedom', async () => {
    expect(sketch.status).toBe('unsolved');
    const { p } = rectangle(sketch);
    await sketch.solve(solver);
    expect(sketch.status).toBe('under-constrained');
    expect(sketch.dof).toBeGreaterThan(0);

    for (let i = 0; i < 6; i++) {
      sketch.addConstraint({ type: 'coincident', a: p[1]!, b: p[2]! });
    }
    await sketch.solve(solver);
    expect(sketch.status).toBe('fully-constrained');
  });

  it('reports over-constrained when the solver finds a conflict', async () => {
    rectangle(sketch);
    solver.conflicting = ['k3'];
    await sketch.solve(solver);
    expect(sketch.status).toBe('over-constrained');
    expect(sketch.lastSolve!.conflicting).toEqual(['k3']);
  });
});

describe('persistence', () => {
  it('round-trips geometry, constraints and the plane', () => {
    const { p, l } = rectangle(sketch);
    sketch.addConstraint({ type: 'horizontal', line: l[0]! });
    sketch.addConstraint({ type: 'distance', a: p[0]!, b: p[1]!, value: 'width' });

    const reloaded = Sketch.fromJSON(JSON.parse(JSON.stringify(sketch.toJSON())));
    expect(reloaded.geometry).toHaveLength(sketch.geometry.length);
    expect(reloaded.constraints).toHaveLength(2);
    expect(reloaded.plane).toEqual({ kind: 'origin', plane: 'xy' });
    expect(reloaded.referencedParameters()).toEqual(['width']);
  });

  it('does not reuse an id already present in the file', () => {
    rectangle(sketch);
    const reloaded = Sketch.fromJSON(sketch.toJSON());
    const existing = new Set(reloaded.geometry.map((e) => e.id));
    expect(existing.has(reloaded.newId('p'))).toBe(false);
  });
});

describe('reference dimensions', () => {
  it('take no freedom away until they are made to drive', async () => {
    const { Sketch } = await import('./sketch.js');
    const { MockSolver } = await import('./mock-solver.js');
    const sketch = new Sketch({ kind: 'origin', plane: 'xy' });
    sketch.addPoint(0, 0, { fixed: true, id: 'o' });
    const a = sketch.addPoint(10, 0);
    const solver = new MockSolver();
    await sketch.solve(solver, {});
    const free = sketch.dof;

    const id = sketch.addConstraint({ type: 'distance', a: 'o', b: a, value: 10, reference: true } as never);
    await sketch.solve(solver, {});
    expect(sketch.dof).toBe(free);

    sketch.removeConstraint(id);
    sketch.addConstraint({ type: 'distance', a: 'o', b: a, value: 10 });
    await sketch.solve(solver, {});
    expect(sketch.dof).toBe(free! - 1);
  });
});
