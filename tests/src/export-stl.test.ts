import { beforeAll, describe, expect, it } from 'vitest';
import { asFeatureId } from '@cardstock/types';
import { Document } from '@cardstock/document';
import { PlaneGcsSolver, createOcctKernel, type OcctKernel } from '@cardstock/kernel';

/**
 * Export, read back, and measure.
 *
 * "It produced bytes" is not evidence: the failure that matters is a file that opens in
 * a slicer and is the wrong size, or is missing half the part.
 */
let kernel: OcctKernel;
let solver: PlaneGcsSolver;
beforeAll(async () => {
  kernel = await createOcctKernel();
  solver = await PlaneGcsSolver.create();
}, 60_000);

const id = (s: string) => asFeatureId(s);

/** Triangles, bounds and edge use-counts from a binary STL. */
function readStl(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(80, true);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  // A watertight mesh uses every edge exactly twice, once from each side.
  const edges = new Map<string, number>();
  const round = (v: number) => Math.round(v * 1e4) / 1e4;

  for (let t = 0; t < count; t++) {
    const at = 84 + t * 50 + 12; // skip the header, then this triangle's normal
    const corners: number[][] = [];
    for (let c = 0; c < 3; c++) {
      const p = [0, 1, 2].map((axis) => view.getFloat32(at + c * 12 + axis * 4, true));
      corners.push(p);
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis]!, p[axis]!);
        max[axis] = Math.max(max[axis]!, p[axis]!);
      }
    }
    for (let c = 0; c < 3; c++) {
      const a = corners[c]!.map(round).join(',');
      const b = corners[(c + 1) % 3]!.map(round).join(',');
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }

  return {
    count, min, max,
    size: [max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!],
    watertight: [...edges.values()].every((n) => n === 2),
  };
}

/** A rectangle on XY, lower-left at (x, y). */
function rect(doc: Document, x: number, y: number, w: number, h: number) {
  const { sketch, id: sketchId } = doc.addSketch({ kind: 'origin', plane: 'xy' });
  const a = sketch.addPoint(x, y);
  const b = sketch.addPoint(x + w - 1, y + 1);
  const c = sketch.addPoint(x + w, y + h);
  const d = sketch.addPoint(x - 1, y + h - 1);
  sketch.addConstraint({ type: 'horizontal', line: sketch.addLine(a, b) });
  sketch.addConstraint({ type: 'vertical', line: sketch.addLine(b, c) });
  sketch.addConstraint({ type: 'horizontal', line: sketch.addLine(c, d) });
  sketch.addConstraint({ type: 'vertical', line: sketch.addLine(d, a) });
  sketch.addConstraint({ type: 'lockX', point: a, value: String(x) });
  sketch.addConstraint({ type: 'lockY', point: a, value: String(y) });
  sketch.addConstraint({ type: 'distance', a, b, value: String(w) });
  sketch.addConstraint({ type: 'distance', a: b, b: c, value: String(h) });
  return sketchId;
}

describe('exporting for a slicer', () => {
  it('writes a watertight mesh at the modelled dimensions', async () => {
    const doc = new Document(kernel, undefined, solver);
    const profile = rect(doc, 0, 0, 60, 40);
    doc.addFeature({
      id: id('ex1'), type: 'extrude', name: 'Plate',
      values: { distance: '12' }, inputs: { profile },
    });
    const handle = (await doc.recompute()).states.get(id('ex1'))!.handle!;

    const stl = readStl(await kernel.exportStl(handle));
    expect(stl.count).toBe(12); // a box, two triangles a face
    expect(stl.watertight).toBe(true);
    expect(stl.size[0]).toBeCloseTo(60, 3);
    expect(stl.size[1]).toBeCloseTo(40, 3);
    expect(stl.size[2]).toBeCloseTo(12, 3);
  });

  it('exports EVERY body, not only the last one', async () => {
    // The bug this guards: a part built from several sketches exporting as one body,
    // with nothing in the file to say the rest is missing.
    const doc = new Document(kernel, undefined, solver);
    doc.addFeature({
      id: id('a'), type: 'extrude', name: 'A',
      values: { distance: '10' }, inputs: { profile: rect(doc, 0, 0, 20, 20) },
    });
    doc.addFeature({
      id: id('b'), type: 'extrude', name: 'B',
      values: { distance: '10' }, inputs: { profile: rect(doc, 100, 0, 20, 20) },
    });
    const states = (await doc.recompute()).states;
    const both = await kernel.compound([
      states.get(id('a'))!.handle!, states.get(id('b'))!.handle!,
    ]);

    const stl = readStl(await kernel.exportStl(both.handle));
    expect(stl.count).toBe(24); // two boxes
    // Spanning both bodies proves the second one is really in the file.
    expect(stl.min[0]).toBeCloseTo(0, 3);
    expect(stl.max[0]).toBeCloseTo(120, 3);
  });

  it('exports at export quality, not whatever the viewer last tessellated', async () => {
    // BRepMesh_IncrementalMesh caches its triangulation on the shape, so a display
    // tessellation first used to leak a coarse mesh into the STL.
    const doc = new Document(kernel, undefined, solver);
    doc.addFeature({
      id: id('cyl'), type: 'cylinder', name: 'Rod',
      values: { radius: '10', height: '20' }, inputs: {},
    });
    const handle = (await doc.recompute()).states.get(id('cyl'))!.handle!;

    await kernel.tessellate(handle, 'preview' as never, {
      linearDeflection: 0.5, angularDeflection: 0.7,
    });
    const stl = readStl(await kernel.exportStl(handle));

    // A coarse display mesh gives a visibly faceted cylinder; export quality does not.
    expect(stl.count).toBeGreaterThan(100);
    expect(stl.watertight).toBe(true);
    // The facets sit inside the true radius, so the span is slightly under 20.
    expect(stl.size[0]).toBeGreaterThan(19.9);
    expect(stl.size[0]).toBeLessThanOrEqual(20.001);
  });

  it('keeps a hole in the exported mesh', async () => {
    const doc = new Document(kernel, undefined, solver);
    doc.addFeature({
      id: id('plate'), type: 'extrude', name: 'Plate',
      values: { distance: '10' }, inputs: { profile: rect(doc, 0, 0, 40, 40) },
    });
    doc.addFeature({
      id: id('hole1'), type: 'hole', name: 'Hole',
      values: { standard: 'M4', fit: 'normal', x: '20', y: '20', z: '10', depth: '12' },
      inputs: { base: id('plate') },
    });
    const handle = (await doc.recompute()).states.get(id('hole1'))!.handle!;

    const stl = readStl(await kernel.exportStl(handle));
    expect(stl.watertight).toBe(true);
    // A plain plate is 12 triangles; the hole's wall adds many more.
    expect(stl.count).toBeGreaterThan(50);
  });
});
