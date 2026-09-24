import { beforeAll, describe, expect, it } from 'vitest';
import type { SketchConstraint, SketchGeometry, SolveRequest } from '@cardstock/types';
import { PlaneGcsSolver } from './planegcs.js';

/**
 * The solver adapter against the real PlaneGCS.
 *
 * Assertions are on solved coordinates, not on "it returned success", because a solver
 * that reports success while leaving the geometry wrong is the failure that matters.
 */
let solver: PlaneGcsSolver;
beforeAll(async () => { solver = await PlaneGcsSolver.create(); }, 60_000);

/** A rectangle from deliberately sloppy points, as if drawn by hand. */
function rectangle(width: number | string, height: number | string): SolveRequest {
  const geometry: SketchGeometry[] = [
    { id: 'p1', type: 'point', x: 0.3, y: -0.2 },
    { id: 'p2', type: 'point', x: 41, y: 1.7 },
    { id: 'p3', type: 'point', x: 38, y: 22 },
    { id: 'p4', type: 'point', x: -1.2, y: 19 },
    { id: 'bottom', type: 'line', p1: 'p1', p2: 'p2' },
    { id: 'right', type: 'line', p1: 'p2', p2: 'p3' },
    { id: 'top', type: 'line', p1: 'p3', p2: 'p4' },
    { id: 'left', type: 'line', p1: 'p4', p2: 'p1' },
  ];
  const constraints: SketchConstraint[] = [
    { id: 'ox', type: 'lockX', point: 'p1', value: 0 },
    { id: 'oy', type: 'lockY', point: 'p1', value: 0 },
    { id: 'h1', type: 'horizontal', line: 'bottom' },
    { id: 'h2', type: 'horizontal', line: 'top' },
    { id: 'v1', type: 'vertical', line: 'right' },
    { id: 'v2', type: 'vertical', line: 'left' },
    { id: 'w', type: 'distance', a: 'p1', b: 'p2', value: width },
    { id: 'h', type: 'distance', a: 'p2', b: 'p3', value: height },
  ];
  return { geometry, constraints, parameters: {} };
}

describe('solving', () => {
  it('turns sloppy input into an exact rectangle', async () => {
    const result = await solver.solve(rectangle(40, 20));
    expect(result.status).toBe('solved');
    expect(result.dof).toBe(0);
    expect(result.points.p1).toEqual({ x: 0, y: 0 });
    expect(result.points.p2!.x).toBeCloseTo(40, 9);
    expect(result.points.p2!.y).toBeCloseTo(0, 9);
    expect(result.points.p3!.x).toBeCloseTo(40, 9);
    expect(result.points.p3!.y).toBeCloseTo(20, 9);
  });

  it('drives dimensions from named parameters', async () => {
    // The mechanism that makes a sketch follow the rest of the model.
    const request = { ...rectangle('W', 'H'), parameters: { W: 55, H: 12.5 } };
    const result = await solver.solve(request);
    expect(result.status).toBe('solved');
    expect(result.points.p2!.x).toBeCloseTo(55, 9);
    expect(result.points.p3!.y).toBeCloseTo(12.5, 9);
  });

  it('reflects a changed parameter on the next solve', async () => {
    const first = await solver.solve({ ...rectangle('W', 'H'), parameters: { W: 30, H: 30 } });
    const second = await solver.solve({ ...rectangle('W', 'H'), parameters: { W: 80, H: 30 } });
    expect(first.points.p2!.x).toBeCloseTo(30, 9);
    expect(second.points.p2!.x).toBeCloseTo(80, 9);
  });

  it('solves circles and radius constraints', async () => {
    const result = await solver.solve({
      geometry: [
        { id: 'c', type: 'point', x: 3, y: 4 },
        { id: 'circle', type: 'circle', centre: 'c', radius: 1 },
      ],
      constraints: [
        { id: 'cx', type: 'lockX', point: 'c', value: 10 },
        { id: 'cy', type: 'lockY', point: 'c', value: 5 },
        { id: 'r', type: 'radius', entity: 'circle', value: 7.5 },
      ],
      parameters: {},
    });
    expect(result.status).toBe('solved');
    expect(result.points.c).toEqual({ x: 10, y: 5 });
    expect(result.radii.circle).toBeCloseTo(7.5, 9);
    expect(result.dof).toBe(0);
  });
});

describe('degrees of freedom', () => {
  const line = (constraints: SketchConstraint[]) => solver.solve({
    geometry: [
      { id: 'a', type: 'point', x: 0, y: 0 },
      { id: 'b', type: 'point', x: 30, y: 5 },
      { id: 'l', type: 'line', p1: 'a', p2: 'b' },
    ],
    constraints: [
      { id: 'ax', type: 'lockX', point: 'a', value: 0 },
      { id: 'ay', type: 'lockY', point: 'a', value: 0 },
      ...constraints,
    ],
    parameters: {},
  });

  it('counts down as constraints are added', async () => {
    // The number the sketcher shows, because "how much of this is pinned down" is the
    // question you are always asking.
    expect((await line([])).dof).toBe(2);
    expect((await line([{ id: 'h', type: 'horizontal', line: 'l' }])).dof).toBe(1);
    expect((await line([
      { id: 'h', type: 'horizontal', line: 'l' },
      { id: 'd', type: 'distance', a: 'a', b: 'b', value: 30 },
    ])).dof).toBe(0);
  });
});

describe('diagnostics name OUR constraints', () => {
  it('identifies contradictory constraints by the ids we gave them', async () => {
    // Actionable means naming the thing the user placed, not an internal index.
    const result = await solver.solve({
      geometry: [
        { id: 'a', type: 'point', x: 0, y: 0 },
        { id: 'b', type: 'point', x: 30, y: 0 },
        { id: 'l', type: 'line', p1: 'a', p2: 'b' },
      ],
      constraints: [
        { id: 'ax', type: 'lockX', point: 'a', value: 0 },
        { id: 'ay', type: 'lockY', point: 'a', value: 0 },
        { id: 'horiz', type: 'horizontal', line: 'l' },
        { id: 'len30', type: 'distance', a: 'a', b: 'b', value: 30 },
        { id: 'len45', type: 'distance', a: 'a', b: 'b', value: 45 },
      ],
      parameters: {},
    });
    expect(result.status).toBe('failed');
    expect(result.conflicting).toContain('len30');
    expect(result.conflicting).toContain('len45');
  });

  it('never reports an internal helper as something to delete', async () => {
    const result = await solver.solve({
      ...rectangle(40, 20),
      drag: { point: 'p3', x: 100, y: 100 },
    });
    for (const id of [...result.conflicting, ...result.redundant]) {
      expect(id.startsWith('__')).toBe(false);
    }
  });
});

describe('dragging', () => {
  it('does not break a fully constrained sketch', async () => {
    // Dragging a finished sketch must be a no-op, not a conflict. Adding a constraint
    // for the drag would over-constrain it and report a contradiction the user never
    // created.
    const result = await solver.solve({
      ...rectangle(40, 20),
      drag: { point: 'p3', x: 400, y: 400 },
    });
    expect(['solved', 'converged']).toContain(result.status);
    expect(result.conflicting).toEqual([]);
    expect(result.points.p2!.x - result.points.p1!.x).toBeCloseTo(40, 6);
    expect(Math.abs(result.points.p3!.y - result.points.p2!.y)).toBeCloseTo(20, 6);
  });

  it('moves a point that is actually free', async () => {
    const base = {
      geometry: [
        { id: 'a', type: 'point' as const, x: 0, y: 0 },
        { id: 'b', type: 'point' as const, x: 10, y: 0 },
        { id: 'l', type: 'line' as const, p1: 'a', p2: 'b' },
      ],
      constraints: [
        { id: 'ax', type: 'lockX' as const, point: 'a', value: 0 },
        { id: 'ay', type: 'lockY' as const, point: 'a', value: 0 },
        { id: 'h', type: 'horizontal' as const, line: 'l' },
      ],
      parameters: {},
    };
    // The far end is free along X, so a drag must take it there — while the horizontal
    // constraint keeps y at zero.
    const result = await solver.solve({ ...base, drag: { point: 'b', x: 75, y: 60 } });
    expect(['solved', 'converged']).toContain(result.status);
    expect(result.points.b!.x).toBeCloseTo(75, 6);
    expect(result.points.b!.y).toBeCloseTo(0, 6);
  });
});

describe('robustness', () => {
  it('returns the input geometry when a request is malformed, rather than throwing', async () => {
    const result = await solver.solve({
      geometry: [{ id: 'a', type: 'point', x: 1, y: 2 }],
      constraints: [{ id: 'bad', type: 'coincident', a: 'a', b: 'ghost' }],
      parameters: {},
    });
    expect(result.status).toBe('invalid');
    expect(result.points.a).toEqual({ x: 1, y: 2 });
    expect(result.message).toBeTruthy();
  });

  it('handles an empty sketch', async () => {
    const result = await solver.solve({ geometry: [], constraints: [], parameters: {} });
    expect(result.points).toEqual({});
  });
});

describe('distance dimensions between kinds', () => {
  const base = (): SketchGeometry[] => [
    { id: 'o', type: 'point', x: 0, y: 0, fixed: true },
    { id: 'a', type: 'point', x: 30, y: 0 },
    { id: 'b', type: 'point', x: 1, y: 10 },
    { id: 'c', type: 'point', x: 29, y: 11 },
    { id: 'base', type: 'line', p1: 'o', p2: 'a' },
    { id: 'upper', type: 'line', p1: 'b', p2: 'c' },
    { id: 'k', type: 'point', x: 15, y: 30 },
    { id: 'ring', type: 'circle', centre: 'k', radius: 5 },
  ];

  it('two parallel lines sit at the given gap', async () => {
    const result = await solver.solve({
      geometry: base(), parameters: {},
      constraints: [
        { id: 'h', type: 'horizontal', line: 'base' },
        { id: 'par', type: 'parallel', a: 'upper', b: 'base' },
        { id: 'gap', type: 'lineLineDistance', a: 'upper', b: 'base', value: 12 },
      ],
    });
    expect(['solved', 'converged']).toContain(result.status);
    expect(result.points.b!.y).toBeCloseTo(12, 5);
    expect(result.points.c!.y).toBeCloseTo(12, 5);
  });

  it('a circle rim sits at the given distance from a line and from a point', async () => {
    const result = await solver.solve({
      geometry: base(), parameters: {},
      constraints: [
        { id: 'h', type: 'horizontal', line: 'base' },
        { id: 'r', type: 'radius', entity: 'ring', value: 5 },
        { id: 'kx', type: 'lockX', point: 'k', value: 15 },
        { id: 'cl', type: 'circleLineDistance', circle: 'ring', line: 'base', value: 20 },
        // 25 from the rim, so 30 from the centre: reachable from y = 0 with the
        // centre 25 up. (4 would not be, and the solver rightly fails on it.)
        { id: 'pc', type: 'pointCircleDistance', point: 'a', circle: 'ring', value: 25 },
      ],
    });
    expect(['solved', 'converged']).toContain(result.status);
    expect(result.points.k!.y).toBeCloseTo(25, 4); // 20 to the line plus the radius
    const gap = Math.hypot(result.points.a!.x - 15, result.points.a!.y - 25) - 5;
    expect(gap).toBeCloseTo(25, 4);
  });
});

describe('arcs', () => {
  /**
   * An arc on two ends, as the tool makes it: the ends are the points that were
   * clicked, the centre is free, and the sweep is the arc's own end angle minus its
   * start angle. No axis — the arc is measured against itself.
   */
  const onEnds = (sweepDeg = 180): SketchGeometry[] => {
    const theta = (sweepDeg * Math.PI) / 180;
    // The ends placed where that sweep puts them on a radius-20 circle centred at
    // (20, 0), which is the seeding the Sketch does before every solve.
    const start = -theta / 2, end = theta / 2;
    const at = (angle: number) => ({ x: 20 + 20 * Math.cos(angle), y: 20 * Math.sin(angle) });
    return [
      { id: 'c', type: 'point', x: 20, y: 0 },
      { id: 's', type: 'point', ...at(start) },
      { id: 'e', type: 'point', ...at(end) },
      { id: 'arc', type: 'arc', centre: 'c', radius: 20, start: 's', end: 'e', startAngle: start, endAngle: end },
    ];
  };

  it('keeps its ends on the arc and reports its angles', async () => {
    const result = await solver.solve({ geometry: onEnds(), parameters: {}, constraints: [
      { id: 'sweep', type: 'sweep', entity: 'arc', value: 180 },
    ] });
    expect(['solved', 'converged']).toContain(result.status);
    expect(result.angles!.arc!.end - result.angles!.arc!.start).toBeCloseTo(Math.PI, 6);
    for (const id of ['s', 'e']) {
      const p = result.points[id]!;
      expect(Math.hypot(p.x - result.points.c!.x, p.y - result.points.c!.y))
        .toBeCloseTo(result.radii.arc!, 5);
    }
  });

  it('holds the sweep the dimension asks for', async () => {
    const result = await solver.solve({ geometry: onEnds(180), parameters: {}, constraints: [
      { id: 'sweep', type: 'sweep', entity: 'arc', value: 90 },
    ] });
    expect(result.status).toBe('solved');
    expect(result.angles!.arc!.end - result.angles!.arc!.start).toBeCloseTo(Math.PI / 2, 5);
  });

  it('reads a negative sweep as the same arc drawn the other way round', async () => {
    // The sign IS the direction, and that is what flips an arc to the other side of
    // its two ends. It used to be "which side of the axis the bulge falls on".
    const result = await solver.solve({ geometry: onEnds(-90), parameters: {}, constraints: [
      { id: 'sweep', type: 'sweep', entity: 'arc', value: -90 },
    ] });
    expect(result.status).toBe('solved');
    expect(result.angles!.arc!.end - result.angles!.arc!.start).toBeCloseTo(-Math.PI / 2, 5);
  });

  it('pins its ends where they were clicked while the radius follows the sweep', async () => {
    // The ends are the two points the user picked, so they are what stays put; a
    // shallower sweep across the same chord means a bigger circle.
    const geometry = onEnds().map((e) =>
      (e.id === 's' || e.id === 'e' ? { ...e, fixed: true } : e)) as SketchGeometry[];
    const result = await solver.solve({ geometry, parameters: {}, constraints: [
      { id: 'sweep', type: 'sweep', entity: 'arc', value: 90 },
    ] });
    expect(result.status).toBe('solved');
    // Chord 40 across a 90 degree sweep: r = (chord / 2) / sin(45 degrees).
    expect(result.radii.arc).toBeCloseTo(20 / Math.sin(Math.PI / 4), 4);
  });

  it('takes a radius dimension as well, and then the ends give instead', async () => {
    const result = await solver.solve({ geometry: onEnds(), parameters: {}, constraints: [
      { id: 'sweep', type: 'sweep', entity: 'arc', value: 180 },
      { id: 'r', type: 'radius', entity: 'arc', value: 12 },
    ] });
    expect(result.status).toBe('solved');
    expect(result.radii.arc).toBeCloseTo(12, 5);
    expect(result.conflicting).toEqual([]);
  });
});

describe('equal', () => {
  it('equalises line lengths and circle/arc radii, rather than failing on entity ids', async () => {
    const geometry: SketchGeometry[] = [
      { id: 'o', type: 'point', x: 0, y: 0, fixed: true },
      { id: 'a', type: 'point', x: 30, y: 0 },
      { id: 'b', type: 'point', x: 0, y: 10, fixed: true },
      { id: 'c', type: 'point', x: 12, y: 10 },
      { id: 'l1', type: 'line', p1: 'o', p2: 'a' },
      { id: 'l2', type: 'line', p1: 'b', p2: 'c' },
      { id: 'k1', type: 'point', x: 50, y: 50, fixed: true },
      { id: 'ring', type: 'circle', centre: 'k1', radius: 5 },
      { id: 'k2', type: 'point', x: 80, y: 50, fixed: true },
      { id: 's', type: 'point', x: 90, y: 50 },
      { id: 'e', type: 'point', x: 80, y: 60 },
      { id: 'arc', type: 'arc', centre: 'k2', radius: 10, start: 's', end: 'e', startAngle: 0, endAngle: Math.PI / 2 },
    ];
    const result = await solver.solve({ geometry, parameters: {}, constraints: [
      { id: 'h1', type: 'horizontal', line: 'l1' }, { id: 'h2', type: 'horizontal', line: 'l2' },
      { id: 'eqL', type: 'equal', a: 'l1', b: 'l2' },
      { id: 'r', type: 'radius', entity: 'ring', value: 5 },
      { id: 'eqR', type: 'equal', a: 'ring', b: 'arc' },
    ] });
    expect(result.status).toBe('solved');
    expect(result.points.c!.x - result.points.b!.x).toBeCloseTo(result.points.a!.x - result.points.o!.x, 5);
    expect(result.radii.arc).toBeCloseTo(5, 5);
  });
});

describe('geometry order', () => {
  it('solves a curve whose points are declared after it', async () => {
    // Trimming rewrites a circle into an arc in place, and the arc then references rim
    // points added after it. GCS resolves an id as the primitive is pushed, so the
    // solve failed with "sketch object p2 not found" until points went first.
    const result = await solver.solve({
      geometry: [
        { id: 'c', type: 'point', x: 0, y: 0, fixed: true },
        { id: 'arc', type: 'arc', centre: 'c', radius: 10, start: 'p1', end: 'p2', startAngle: 0, endAngle: Math.PI },
        { id: 'p1', type: 'point', x: 10, y: 0 },
        { id: 'p2', type: 'point', x: -10, y: 0 },
      ],
      constraints: [{ id: 'r', type: 'radius', entity: 'arc', value: 10 }],
      parameters: {},
    });
    expect(result.status).toBe('solved');
    expect(result.message).toBeUndefined();
    expect(result.radii.arc).toBeCloseTo(10, 6);
  });
});
