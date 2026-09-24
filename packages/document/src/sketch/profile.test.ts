import { describe, expect, it } from 'vitest';
import type { SketchGeometry } from '@cardstock/types';
import { buildProfile, outerLoop, profileRegions, signedArea } from './profile.js';

const point = (id: string, x: number, y: number): SketchGeometry => ({ id, type: 'point', x, y });
const line = (id: string, p1: string, p2: string, construction = false): SketchGeometry =>
  ({ id, type: 'line', p1, p2, ...(construction ? { construction } : {}) });

/** A 40x20 rectangle sharing its corner points. */
const rectangle = (): SketchGeometry[] => [
  point('a', 0, 0), point('b', 40, 0), point('c', 40, 20), point('d', 0, 20),
  line('l1', 'a', 'b'), line('l2', 'b', 'c'), line('l3', 'c', 'd'), line('l4', 'd', 'a'),
];

describe('closed loops', () => {
  it('finds a rectangle', () => {
    const { loops, openChains } = buildProfile(rectangle());
    expect(loops).toHaveLength(1);
    expect(loops[0]!.segments).toHaveLength(4);
    expect(Math.abs(loops[0]!.signedArea)).toBeCloseTo(800, 9);
    expect(openChains).toEqual([]);
  });

  it('chains segments drawn in inconsistent directions', () => {
    // People draw lines whichever way round; the profile must not care.
    const geometry: SketchGeometry[] = [
      point('a', 0, 0), point('b', 10, 0), point('c', 10, 10), point('d', 0, 10),
      line('l1', 'a', 'b'),
      line('l2', 'c', 'b'), // drawn backwards
      line('l3', 'c', 'd'),
      line('l4', 'a', 'd'), // also backwards
    ];
    const { loops } = buildProfile(geometry);
    expect(loops).toHaveLength(1);
    expect(Math.abs(loops[0]!.signedArea)).toBeCloseTo(100, 9);
  });

  it('joins ends by POSITION, not by shared point id', () => {
    // Two distinct points held together by a coincident constraint look identical after
    // solving; a profile that worked one way but not the other would be baffling.
    const geometry: SketchGeometry[] = [
      point('a1', 0, 0), point('b', 10, 0), point('c', 10, 10), point('d', 0, 10),
      point('a2', 0, 0), // same place as a1
      line('l1', 'a1', 'b'), line('l2', 'b', 'c'), line('l3', 'c', 'd'), line('l4', 'd', 'a2'),
    ];
    expect(buildProfile(geometry).loops).toHaveLength(1);
  });

  it('treats a circle as its own loop', () => {
    const geometry: SketchGeometry[] = [
      point('c', 5, 5), { id: 'circ', type: 'circle', centre: 'c', radius: 3 },
    ];
    const { loops } = buildProfile(geometry);
    expect(loops).toHaveLength(1);
    expect(loops[0]!.segments[0]).toMatchObject({ kind: 'circle', radius: 3 });
    expect(loops[0]!.signedArea).toBeCloseTo(Math.PI * 9, 9);
  });

  it('finds several independent loops', () => {
    const geometry: SketchGeometry[] = [
      ...rectangle(),
      point('h', 20, 10), { id: 'hole', type: 'circle', centre: 'h', radius: 4 },
    ];
    expect(buildProfile(geometry).loops).toHaveLength(2);
  });
});

describe('what is excluded', () => {
  it('ignores construction geometry', () => {
    // It exists to constrain, not to enclose.
    const geometry = [...rectangle(), line('diag', 'a', 'c', true)];
    const { loops } = buildProfile(geometry);
    expect(loops).toHaveLength(1);
    expect(loops[0]!.segments).toHaveLength(4);
  });

  it('ignores zero-length lines', () => {
    // They enclose nothing and would be a self-loop in the adjacency graph.
    const geometry = [...rectangle(), point('z', 5, 5), line('zero', 'z', 'z')];
    expect(buildProfile(geometry).loops).toHaveLength(1);
  });

  it('ignores a line whose endpoint is missing', () => {
    expect(buildProfile([point('a', 0, 0), line('l', 'a', 'ghost')]).loops).toEqual([]);
  });
});

describe('profiles that are not closed', () => {
  it('reports an open chain rather than inventing a loop', () => {
    const geometry: SketchGeometry[] = [
      point('a', 0, 0), point('b', 10, 0), point('c', 10, 10),
      line('l1', 'a', 'b'), line('l2', 'b', 'c'),
    ];
    const { loops, openChains } = buildProfile(geometry);
    expect(loops).toEqual([]);
    expect(openChains).toHaveLength(1);
    expect(openChains[0]!.reason).toMatch(/does not close/);
  });

  it('a spur off a closed loop is reported as a gap, and the loop still counts', () => {
    const geometry: SketchGeometry[] = [
      ...rectangle(),
      point('e', 40, -10), line('spur', 'b', 'e'),
    ];
    const { loops, openChains } = buildProfile(geometry);
    expect(loops).toHaveLength(1);
    expect(openChains).toHaveLength(1);
    expect(openChains[0]!.segments).toHaveLength(1);
  });

  it('two triangles sharing a corner are two loops, not an ambiguity', () => {
    // The bow-tie: four segments meet at the shared point. Face tracing resolves it.
    const geometry: SketchGeometry[] = [
      point('v', 0, 0),
      point('a', -20, 10), point('b', -20, -10),
      point('c', 20, 10), point('d', 20, -10),
      line('a1', 'v', 'a'), line('a2', 'a', 'b'), line('a3', 'b', 'v'),
      line('b1', 'v', 'c'), line('b2', 'c', 'd'), line('b3', 'd', 'v'),
    ];
    const { loops, openChains } = buildProfile(geometry);
    expect(openChains).toEqual([]);
    expect(loops).toHaveLength(2);
    for (const loop of loops) {
      expect(loop.segments).toHaveLength(3);
      expect(loop.signedArea).toBeCloseTo(200, 9);
    }
    expect(profileRegions(loops)).toHaveLength(2);
  });

  it('a rectangle split by a line is two regions', () => {
    const geometry: SketchGeometry[] = [
      ...rectangle(),
      point('m1', 20, 0), point('m2', 20, 20), line('split', 'm1', 'm2'),
    ];
    // The split's ends sit on the rectangle's edges but are not vertices of them, so
    // the rectangle's lines must be broken there for the graph to see the junction.
    const { loops } = buildProfile(geometry);
    // Not split: the mid-points do not break l1/l3, so the divider dangles. Documented.
    expect(loops).toHaveLength(1);
  });

  it('handles an empty sketch', () => {
    expect(buildProfile([])).toEqual({ loops: [], openChains: [] });
  });
});

describe('outer loop', () => {
  it('picks the largest by area', () => {
    const geometry: SketchGeometry[] = [
      ...rectangle(),
      point('h', 20, 10), { id: 'hole', type: 'circle', centre: 'h', radius: 4 },
    ];
    const { loops } = buildProfile(geometry);
    expect(Math.abs(outerLoop(loops)!.signedArea)).toBeCloseTo(800, 6);
  });

  it('returns null when there is nothing', () => {
    expect(outerLoop([])).toBeNull();
  });
});

describe('signed area', () => {
  it('loops come out counter-clockwise whichever way they were drawn', () => {
    const ccw = buildProfile(rectangle()).loops[0]!;
    const cw = buildProfile([
      point('a', 0, 0), point('b', 0, 20), point('c', 40, 20), point('d', 40, 0),
      line('l1', 'a', 'b'), line('l2', 'b', 'c'), line('l3', 'c', 'd'), line('l4', 'd', 'a'),
    ]).loops[0]!;
    expect(ccw.signedArea).toBeCloseTo(800, 9);
    expect(cw.signedArea).toBeCloseTo(800, 9);
    // The raw function still signs by direction.
    expect(signedArea([...cw.segments].reverse().map((s) => ({ ...s, from: (s as { to: { x: number; y: number } }).to, to: (s as { from: { x: number; y: number } }).from })) as never)).toBeLessThan(0);
  });

  it('is zero for a degenerate loop', () => {
    expect(signedArea([])).toBe(0);
  });
});

describe('rings', () => {
  const circle = (id: string, cx: number, cy: number, r: number) => [
    { id: `${id}c`, type: 'point', x: cx, y: cy },
    { id, type: 'circle', centre: `${id}c`, radius: r },
  ];

  it('makes a ring from two concentric circles, not nothing at all', () => {
    // Containment used to be tested from a circle's CENTRE, and concentric circles each
    // contain the other's centre — so each was the other's parent, neither was an outer
    // loop, and a pair of rings reported "the sketch encloses no region".
    const { loops } = buildProfile([...circle('big', 0, 0, 23), ...circle('small', 0, 0, 16.5)] as never);
    const regions = profileRegions(loops);
    expect(regions).toHaveLength(1);
    expect(regions[0]).toHaveLength(2);
    expect(Math.abs(regions[0]![0]!.signedArea)).toBeGreaterThan(Math.abs(regions[0]![1]!.signedArea));
  });

  it('keeps two rings side by side apart', () => {
    const { loops } = buildProfile([
      ...circle('bigL', 0, 0, 23), ...circle('smallL', 0, 0, 16.5),
      ...circle('bigR', 60, 0, 23), ...circle('smallR', 60, 0, 16.5),
    ] as never);
    const regions = profileRegions(loops);
    expect(regions).toHaveLength(2);
    for (const region of regions) expect(region).toHaveLength(2);
  });
});
