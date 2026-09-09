import { beforeAll, describe, expect, it } from 'vitest';
import { asBodyId, type ShapeHandle } from '@cardstock/types';
import { createOcctKernel } from './session.js';
import type { OcctKernel } from './kernel.js';

/**
 * Golden tests against real OpenCascade geometry, in Node — no browser, no worker.
 *
 * Volumes are checked against closed-form values rather than snapshots, so a regression
 * shows up as "this is the wrong solid" rather than "this differs from last time".
 */

let kernel: OcctKernel;
beforeAll(async () => { kernel = await createOcctKernel(); }, 60_000);

const box = (dx = 40, dy = 30, dz = 20) => kernel.makeBox({ dx, dy, dz });

describe('primitives', () => {
  it('builds a box with the right volume, area and topology', async () => {
    const { handle } = await box();
    const mass = await kernel.massProperties(handle);
    expect(mass.volume).toBeCloseTo(24000, 6);
    expect(mass.surfaceArea).toBeCloseTo(2 * (40 * 30 + 40 * 20 + 30 * 20), 6);
    expect(mass.centreOfMass).toMatchObject({ x: 20, y: 15, z: 10 });
    expect(await kernel.topologyCounts(handle)).toEqual({ faces: 6, edges: 12, vertices: 8 });
  });

  it('builds a cylinder', async () => {
    const { handle } = await kernel.makeCylinder({ radius: 6, height: 20 });
    const mass = await kernel.massProperties(handle);
    expect(mass.volume).toBeCloseTo(Math.PI * 36 * 20, 4);
    expect(await kernel.topologyCounts(handle)).toMatchObject({ faces: 3 });
  });

  it('builds a sphere', async () => {
    const { handle } = await kernel.makeSphere({ radius: 5 });
    const mass = await kernel.massProperties(handle);
    expect(mass.volume).toBeCloseTo((4 / 3) * Math.PI * 125, 3);
  });

  it('honours the origin', async () => {
    const { handle } = await kernel.makeBox({ dx: 10, dy: 10, dz: 10, origin: { x: 5, y: 0, z: -2 } });
    const bounds = await kernel.boundingBox(handle);
    expect(bounds.min.x).toBeCloseTo(5, 6);
    expect(bounds.min.z).toBeCloseTo(-2, 6);
    expect(bounds.max.x).toBeCloseTo(15, 6);
    expect(bounds.max.z).toBeCloseTo(8, 6);
  });

  it('rejects degenerate dimensions instead of producing a null shape', async () => {
    await expect(kernel.makeBox({ dx: 0, dy: 10, dz: 10 })).rejects.toThrow(/must be positive/);
    await expect(kernel.makeCylinder({ radius: -1, height: 5 })).rejects.toThrow(/must be positive/);
  });
});

describe('booleans', () => {
  it('cuts a through-hole and removes exactly the cylinder volume', async () => {
    const base = await box();
    const drill = await kernel.makeCylinder({
      radius: 6, height: 40, origin: { x: 20, y: 15, z: -10 },
    });
    const { handle } = await kernel.boolean('cut', base.handle, drill.handle);
    const mass = await kernel.massProperties(handle);
    expect(mass.volume).toBeCloseTo(24000 - Math.PI * 36 * 20, 3);
    // The hole adds one cylindrical face and two circular edges.
    expect(await kernel.topologyCounts(handle)).toMatchObject({ faces: 7 });
  });

  it('fuses two overlapping boxes without double-counting the overlap', async () => {
    const a = await kernel.makeBox({ dx: 10, dy: 10, dz: 10 });
    const b = await kernel.makeBox({ dx: 10, dy: 10, dz: 10, origin: { x: 5, y: 0, z: 0 } });
    const { handle } = await kernel.boolean('union', a.handle, b.handle);
    expect((await kernel.massProperties(handle)).volume).toBeCloseTo(1500, 6);
  });

  it('intersects', async () => {
    const a = await kernel.makeBox({ dx: 10, dy: 10, dz: 10 });
    const b = await kernel.makeBox({ dx: 10, dy: 10, dz: 10, origin: { x: 5, y: 0, z: 0 } });
    const { handle } = await kernel.boolean('intersect', a.handle, b.handle);
    expect((await kernel.massProperties(handle)).volume).toBeCloseTo(500, 6);
  });
});

describe('modifications', () => {
  it('fillets an edge, removing the expected sliver', async () => {
    const base = await box();
    const { handle } = await kernel.fillet(base.handle, [0], 4);
    const volume = (await kernel.massProperties(handle)).volume;
    // A quarter-cylinder of material is replaced by the fillet along one 20mm edge:
    // removed = (r^2 - pi r^2 / 4) * length
    const removed = (16 - (Math.PI * 16) / 4) * 20;
    expect(volume).toBeCloseTo(24000 - removed, 2);
    expect(await kernel.topologyCounts(handle)).toMatchObject({ faces: 7 });
  });

  it('chamfers an edge', async () => {
    const base = await box();
    const { handle } = await kernel.chamfer(base.handle, [0], 3);
    const removed = (3 * 3 / 2) * 20;
    expect((await kernel.massProperties(handle)).volume).toBeCloseTo(24000 - removed, 2);
  });

  it('reports a missing edge rather than failing obscurely', async () => {
    const base = await box();
    await expect(kernel.fillet(base.handle, [999], 2))
      .rejects.toThrow(/edge 999 does not exist \(shape has 12\)/);
  });

  it('rejects a fillet radius the geometry cannot take', async () => {
    const base = await kernel.makeBox({ dx: 10, dy: 10, dz: 10 });
    // A 20mm radius on a 10mm box is impossible; OCCT must refuse, not emit a bad solid.
    await expect(kernel.fillet(base.handle, [0], 20)).rejects.toThrow();
  });

  it('translates without changing volume', async () => {
    const base = await box();
    const { handle } = await kernel.transform(base.handle, [
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 0, 0, 1,
    ]);
    expect((await kernel.massProperties(handle)).volume).toBeCloseTo(24000, 6);
    const bounds = await kernel.boundingBox(handle);
    expect(bounds.min.x).toBeCloseTo(100, 6);
    expect(bounds.max.x).toBeCloseTo(140, 6);
  });

  it('reports bounds with no tolerance padding', async () => {
    const { handle } = await box();
    const bounds = await kernel.boundingBox(handle);
    expect(bounds.min.x).toBeCloseTo(0, 9);
    expect(bounds.max.x).toBeCloseTo(40, 9);
  });
});

describe('history capture (what Phase 4 will resolve references through)', () => {
  it('records the face a fillet generated from an edge', async () => {
    const base = await box();
    const { history } = await kernel.fillet(base.handle, [0], 4);
    expect(history).toBeDefined();
    expect(history!.inputs[0]!.generatedFaces.get(0)).toHaveLength(1);
  });

  it('records which faces a boolean modified, and leaves untouched ones out', async () => {
    const base = await box();
    const drill = await kernel.makeCylinder({
      radius: 6, height: 40, origin: { x: 20, y: 15, z: -10 },
    });
    const { history } = await kernel.boolean('cut', base.handle, drill.handle);
    // History is per input. The box contributes exactly the two faces the hole pierces;
    // faces the cut never touched correctly report nothing, which is absence of change
    // rather than absence of history. The cylinder contributes the wall it became.
    expect(history!.inputs).toHaveLength(2);
    expect(history!.inputs[0]!.modifiedFaces.size).toBe(2);
    expect(history!.inputs[1]!.modifiedFaces.size).toBeGreaterThan(0);
  });
});

describe('tessellation', () => {
  it('produces a mesh whose signed volume matches the B-rep', async () => {
    // The check that catches inverted winding, which otherwise looks fine until
    // something is shaded or exported.
    const base = await box();
    const drill = await kernel.makeCylinder({
      radius: 6, height: 40, origin: { x: 20, y: 15, z: -10 },
    });
    const cut = await kernel.boolean('cut', base.handle, drill.handle);
    const mesh = await kernel.tessellate(cut.handle, asBodyId('t'), {
      linearDeflection: 0.02, angularDeflection: 0.2,
    });

    let signed = 0;
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const g = (k: number) => {
        const i = mesh.indices[t + k]! * 3;
        return [mesh.positions[i]!, mesh.positions[i + 1]!, mesh.positions[i + 2]!] as const;
      };
      const [a, b, c] = [g(0), g(1), g(2)];
      signed += (a[0] * (b[1] * c[2] - b[2] * c[1])
        - a[1] * (b[0] * c[2] - b[2] * c[0])
        + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    }
    const exact = (await kernel.massProperties(cut.handle)).volume;
    expect(signed).toBeGreaterThan(0);
    expect(Math.abs(signed - exact) / exact).toBeLessThan(0.005);
  });

  it('tags every triangle and vertex with a face id in range', async () => {
    const { handle } = await box();
    const mesh = await kernel.tessellate(handle, asBodyId('t'), {
      linearDeflection: 0.1, angularDeflection: 0.3,
    });
    expect(mesh.faceCount).toBe(6);
    expect(mesh.triangleFaceId.length).toBe(mesh.indices.length / 3);
    expect(mesh.vertexFaceId.length).toBe(mesh.positions.length / 3);
    expect([...mesh.triangleFaceId].every((f) => f < mesh.faceCount)).toBe(true);
    expect(new Set(mesh.triangleFaceId).size).toBe(6); // every face produced geometry
  });

  it('emits unit normals and edge segments tagged by edge', async () => {
    const { handle } = await box();
    const mesh = await kernel.tessellate(handle, asBodyId('t'), {
      linearDeflection: 0.1, angularDeflection: 0.3,
    });
    for (let i = 0; i < mesh.normals.length; i += 3) {
      const length = Math.hypot(mesh.normals[i]!, mesh.normals[i + 1]!, mesh.normals[i + 2]!);
      expect(length).toBeCloseTo(1, 5);
    }
    expect(mesh.edgeCount).toBe(12);
    expect(mesh.vertexCount).toBe(8);
    expect([...mesh.edgeSegmentId].every((e) => e < mesh.edgeCount)).toBe(true);
  });

  it('reports accurate bounds', async () => {
    const { handle } = await box();
    const mesh = await kernel.tessellate(handle, asBodyId('t'), {
      linearDeflection: 0.1, angularDeflection: 0.3,
    });
    expect(mesh.bounds.max).toMatchObject({ x: 40, y: 30, z: 20 });
  });

  it('finer quality yields more triangles', async () => {
    const { handle } = await kernel.makeCylinder({ radius: 10, height: 10 });
    const coarse = await kernel.tessellate(handle, asBodyId('a'), {
      linearDeflection: 1, angularDeflection: 1,
    });
    const fine = await kernel.tessellate(handle, asBodyId('b'), {
      linearDeflection: 0.01, angularDeflection: 0.1,
    });
    expect(fine.indices.length).toBeGreaterThan(coarse.indices.length);
  });
});

describe('handle lifecycle', () => {
  it('frees shapes on release and refuses to use them afterwards', async () => {
    const { handle } = await box();
    expect(kernel.registry.has(handle)).toBe(true);
    await kernel.release(handle);
    expect(kernel.registry.has(handle)).toBe(false);
    await expect(kernel.massProperties(handle)).rejects.toThrow(/unknown shape handle/);
  });

  it('refcounts, so a shape shared by two handles survives one release', async () => {
    const { handle } = await box();
    kernel.registry.retain(handle);
    await kernel.release(handle);
    expect(kernel.registry.has(handle)).toBe(true);
    await kernel.release(handle);
    expect(kernel.registry.has(handle)).toBe(false);
  });

  it('rejects an unknown handle', async () => {
    await expect(kernel.massProperties('nope' as ShapeHandle))
      .rejects.toThrow(/unknown shape handle/);
  });
});
