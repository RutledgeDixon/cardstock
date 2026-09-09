import { beforeAll, describe, expect, it } from 'vitest';
import { createOcctKernel } from './session.js';
import type { OcctKernel } from './kernel.js';

/**
 * Fingerprints must (a) identify entities distinctly and (b) stay stable when a model is
 * resized, which is the edit that breaks index-based references. See docs/toponaming.md.
 */
let kernel: OcctKernel;
beforeAll(async () => { kernel = await createOcctKernel(); }, 60_000);

describe('geometry types', () => {
  it('names surface and curve types', async () => {
    const { handle } = await kernel.makeBox({ dx: 40, dy: 30, dz: 20 });
    const description = await kernel.describeShape(handle);
    expect(description.faces).toHaveLength(6);
    expect(new Set(description.faces.map((f) => f.geometryType))).toEqual(new Set(['plane']));
    expect(new Set(description.edges.map((e) => e.geometryType))).toEqual(new Set(['line']));
  });

  it('distinguishes a cylindrical hole wall from the planar faces around it', async () => {
    const base = await kernel.makeBox({ dx: 40, dy: 30, dz: 20 });
    const drill = await kernel.makeCylinder({ radius: 6, height: 40, origin: { x: 20, y: 15, z: -10 } });
    const cut = await kernel.boolean('cut', base.handle, drill.handle);
    const description = await kernel.describeShape(cut.handle);
    const types = description.faces.map((f) => f.geometryType);
    expect(types.filter((t) => t === 'cylinder')).toHaveLength(1);
    expect(types.filter((t) => t === 'plane')).toHaveLength(6);
    expect(description.edges.filter((e) => e.geometryType === 'circle')).toHaveLength(2);
  });
});

describe('normals point out of the solid', () => {
  it('gives the six box faces six distinct outward normals', async () => {
    const { handle } = await kernel.makeBox({ dx: 40, dy: 30, dz: 20 });
    const { faces } = await kernel.describeShape(handle);
    const normals = faces.map((f) => f.direction!);
    expect(normals.every((n) => n !== null)).toBe(true);

    // Without the REVERSED flip, opposite faces would fingerprint identically and the
    // resolver could not tell top from bottom.
    const rounded = normals.map((n) => `${Math.round(n.x)},${Math.round(n.y)},${Math.round(n.z)}`);
    expect(new Set(rounded).size).toBe(6);
    expect(rounded).toContain('0,0,1');
    expect(rounded).toContain('0,0,-1');
  });

  it('points the top face up, in model space', async () => {
    const { handle } = await kernel.makeBox({ dx: 10, dy: 10, dz: 10 });
    const { faces } = await kernel.describeShape(handle);
    const top = faces.find((f) => Math.abs(f.centroid.z - 10) < 1e-6)!;
    expect(top.direction!.z).toBeCloseTo(1, 6);
  });
});

describe('normalised coordinates survive resizing', () => {
  it('keeps a corner edge at the same bbox fraction when the box grows', async () => {
    // The whole point: index-based references break here, fingerprints must not.
    const small = await kernel.makeBox({ dx: 40, dy: 30, dz: 20 });
    const large = await kernel.makeBox({ dx: 55, dy: 30, dz: 20 });
    const a = await kernel.describeShape(small.handle);
    const b = await kernel.describeShape(large.handle);

    const verticalEdges = (d: typeof a) => d.edges
      .filter((e) => Math.abs(e.direction!.z) > 0.99)
      .map((e) => `${e.centroidNormalised.x.toFixed(3)},${e.centroidNormalised.y.toFixed(3)}`)
      .sort();

    expect(verticalEdges(a)).toEqual(verticalEdges(b));
    expect(verticalEdges(a)).toHaveLength(4);
  });

  it('keeps face measure ratios stable under uniform scaling', async () => {
    const a = await kernel.describeShape((await kernel.makeBox({ dx: 10, dy: 10, dz: 10 })).handle);
    const b = await kernel.describeShape((await kernel.makeBox({ dx: 30, dy: 30, dz: 30 })).handle);
    const ratios = (d: typeof a) => d.faces.map((f) => +f.measureRatio.toFixed(6)).sort();
    expect(ratios(a)).toEqual(ratios(b));
  });
});

describe('neighbour types', () => {
  it('records the faces meeting at each edge', async () => {
    const base = await kernel.makeBox({ dx: 40, dy: 30, dz: 20 });
    const drill = await kernel.makeCylinder({ radius: 6, height: 40, origin: { x: 20, y: 15, z: -10 } });
    const cut = await kernel.boolean('cut', base.handle, drill.handle);
    const { edges } = await kernel.describeShape(cut.handle);

    // A hole rim is where a plane meets a cylinder; a box corner is plane-plane. That
    // difference is what stops the resolver confusing them.
    expect(edges).toHaveLength(15); // 12 box corners + 2 hole rims + 1 seam
    const rims = edges.filter((e) => e.neighbourTypes.join() === 'cylinder,plane');
    expect(rims).toHaveLength(2);
    for (const rim of rims) expect(rim.geometryType).toBe('circle');

    // A cylindrical face also carries a SEAM edge, where its parameterisation wraps.
    // Both of its sides are the same face, so IsSame dedupe leaves it with a SINGLE
    // neighbour — which conveniently makes it fingerprint distinctly from both rims and
    // corners, so the resolver cannot confuse them.
    const seams = edges.filter((e) => e.neighbourTypes.length === 1);
    expect(seams).toHaveLength(1);
    expect(seams[0]!.geometryType).toBe('line');
    expect(seams[0]!.neighbourTypes).toEqual(['cylinder']);
    // Box corners: line edges between two planes. The seam is also a line, so it must
    // be excluded by its neighbours rather than by its curve type.
    const corners = edges.filter((e) => e.neighbourTypes.join() === 'plane,plane');
    expect(corners).toHaveLength(12);
    for (const corner of corners) expect(corner.geometryType).toBe('line');
  });
});

describe('every entity is fingerprinted', () => {
  it('covers faces, edges and vertices with in-range indices', async () => {
    const { handle } = await kernel.makeBox({ dx: 40, dy: 30, dz: 20 });
    const d = await kernel.describeShape(handle);
    expect(d.faces.map((f) => f.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(d.edges).toHaveLength(12);
    expect(d.vertices).toHaveLength(8);
    expect(d.faces.every((f) => f.measure > 0)).toBe(true);
    expect(d.edges.every((e) => e.measure > 0)).toBe(true);
    for (const f of [...d.faces, ...d.edges, ...d.vertices]) {
      for (const axis of ['x', 'y', 'z'] as const) {
        expect(f.centroidNormalised[axis]).toBeGreaterThanOrEqual(-1e-6);
        expect(f.centroidNormalised[axis]).toBeLessThanOrEqual(1 + 1e-6);
      }
    }
  });
});
