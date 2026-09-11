import { beforeAll, describe, expect, it } from 'vitest';
import { createOcctKernel } from './session.js';
import type { OcctKernel } from './kernel.js';

let kernel: OcctKernel;
beforeAll(async () => { kernel = await createOcctKernel(); }, 60_000);

/** Binary STL: 80-byte header, uint32 triangle count, 50 bytes per triangle. */
function readBinaryStl(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triangles = view.getUint32(80, true);
  return { triangles, expectedLength: 84 + triangles * 50 };
}

const isAscii = (bytes: Uint8Array) =>
  new TextDecoder().decode(bytes.slice(0, 5)) === 'solid';

describe('STL export', () => {
  it('produces a BINARY file whose length matches its triangle count', async () => {
    const { handle } = await kernel.makeBox({ dx: 40, dy: 30, dz: 20 });
    const bytes = await kernel.exportStl(handle);

    // Binary by default, and asserted rather than tolerated: ASCII is roughly five
    // times the size for the same mesh, and StlAPI_Writer's ASCIIMode is not bound on
    // this build, so an export can silently regress to ASCII if the call changes.
    expect(isAscii(bytes)).toBe(false);
    const { triangles, expectedLength } = readBinaryStl(bytes);
    expect(triangles).toBe(12); // a box, however it is tessellated
    expect(bytes.length).toBe(expectedLength);
  });

  it('writes ASCII when asked, and it is much bigger', async () => {
    const { handle } = await kernel.makeBox({ dx: 40, dy: 30, dz: 20 });
    const binary = await kernel.exportStl(handle);
    const ascii = await kernel.exportStl(handle, { binary: false });
    expect(isAscii(ascii)).toBe(true);
    expect(new TextDecoder().decode(ascii).match(/facet normal/g)).toHaveLength(12);
    expect(ascii.length).toBeGreaterThan(binary.length * 3);
  });

  it('exports curved geometry at export quality, not display quality', async () => {
    // The screen only needs to look right; a printed part needs to BE right.
    const { handle } = await kernel.makeCylinder({ radius: 10, height: 20 });
    const fine = await kernel.exportStl(handle);
    const coarse = await kernel.exportStl(handle, {
      quality: { linearDeflection: 2, angularDeflection: 1 },
    });
    expect(fine.length).toBeGreaterThan(coarse.length);
  });

  it('exports a model with a hole', async () => {
    const base = await kernel.makeBox({ dx: 40, dy: 30, dz: 20 });
    const drill = await kernel.makeCylinder({
      radius: 6, height: 40, origin: { x: 20, y: 15, z: -10 },
    });
    const cut = await kernel.boolean('cut', base.handle, drill.handle);
    const bytes = await kernel.exportStl(cut.handle);
    const triangles = isAscii(bytes)
      ? new TextDecoder().decode(bytes).match(/facet normal/g)!.length
      : readBinaryStl(bytes).triangles;
    // Far more than a plain box: the hole wall is many facets.
    expect(triangles).toBeGreaterThan(60);
  });

  it('rejects an unknown handle rather than writing an empty file', async () => {
    await expect(kernel.exportStl('nope' as never)).rejects.toThrow(/unknown shape handle/);
  });
});

describe('quality is not poisoned by an earlier tessellation', () => {
  it('exports at export quality even after the viewer has meshed coarsely', async () => {
    // BRepMesh_IncrementalMesh caches its triangulation on the shape. Without an
    // explicit clean, this exports the coarse DISPLAY mesh: a visibly faceted print
    // from a model that looked perfectly smooth on screen.
    const { handle } = await kernel.makeCylinder({ radius: 10, height: 20 });
    await kernel.tessellate(handle, 'display' as never, {
      linearDeflection: 2, angularDeflection: 1,
    });
    const bytes = await kernel.exportStl(handle);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(80, true)).toBeGreaterThan(200);
  });
});

describe('export formats', () => {
  it('every mesh format agrees on the triangle count and STEP has none', async () => {
    const { handle } = await kernel.makeBox({ dx: 40, dy: 30, dz: 20 });
    const stl = await kernel.exportModel(handle, 'stl');
    const obj = await kernel.exportModel(handle, 'obj');
    const mf = await kernel.exportModel(handle, '3mf');
    const step = await kernel.exportModel(handle, 'step');
    expect(stl.triangles).toBe(12);
    expect(obj.triangles).toBe(12);
    expect(mf.triangles).toBe(12);
    expect(step.triangles).toBe(0);
    expect(new TextDecoder().decode(step.bytes.subarray(0, 12))).toBe('ISO-10303-21');
  });

  it('mesh stats track quality and report a solid as watertight', async () => {
    const { handle } = await kernel.makeCylinder({ radius: 10, height: 20 });
    const fine = await kernel.meshStats(handle, { linearDeflection: 0.01, angularDeflection: 0.1 });
    const coarse = await kernel.meshStats(handle, { linearDeflection: 1, angularDeflection: 1 });
    expect(fine.triangles).toBeGreaterThan(coarse.triangles);
    expect(fine.watertight).toBe(true);
    expect(coarse.watertight).toBe(true);
  });

  it('a cut part exports watertight in every mesh format', async () => {
    const base = await kernel.makeBox({ dx: 40, dy: 30, dz: 20 });
    const drill = await kernel.makeCylinder({ radius: 6, height: 40, origin: { x: 20, y: 15, z: -10 } });
    const cut = await kernel.boolean('cut', base.handle, drill.handle);
    const stats = await kernel.meshStats(cut.handle, { linearDeflection: 0.05, angularDeflection: 0.3 });
    expect(stats.watertight).toBe(true);
    expect(stats.triangles).toBeGreaterThan(12);
  });
});

describe('import', () => {
  it('STEP round-trips a solid with its volume intact', async () => {
    const base = await kernel.makeBox({ dx: 40, dy: 30, dz: 20 });
    const drill = await kernel.makeCylinder({ radius: 6, height: 40, origin: { x: 20, y: 15, z: -10 } });
    const cut = await kernel.boolean('cut', base.handle, drill.handle);
    const before = await kernel.massProperties(cut.handle);
    const step = await kernel.exportModel(cut.handle, 'step');

    const imported = await kernel.importStep(new TextDecoder().decode(step.bytes));
    const after = await kernel.massProperties(imported.handle);
    expect(after.volume).toBeCloseTo(before.volume, 3);
    expect((await kernel.topologyCounts(imported.handle)).faces).toBe(
      (await kernel.topologyCounts(cut.handle)).faces,
    );
  });

  it('refuses text that is not STEP', async () => {
    await expect(kernel.importStep('hello')).rejects.toThrow(/not a STEP file/);
  });

  it('STL becomes a solid with the right volume', async () => {
    const { handle } = await kernel.makeBox({ dx: 10, dy: 20, dz: 30 });
    const stl = await kernel.exportModel(handle, 'stl');
    const imported = await kernel.importStl(stl.bytes);
    const props = await kernel.massProperties(imported.handle);
    expect(props.volume).toBeCloseTo(6000, 3);
    expect((await kernel.topologyCounts(imported.handle)).faces).toBe(12);
  });

  it('a curved STL imports as a solid too', async () => {
    const { handle } = await kernel.makeCylinder({ radius: 10, height: 20 });
    const stl = await kernel.exportModel(handle, 'stl', { quality: { linearDeflection: 0.5, angularDeflection: 0.5 } });
    const imported = await kernel.importStl(stl.bytes);
    const props = await kernel.massProperties(imported.handle);
    // A faceted cylinder is a little under the true volume; well within 5%.
    expect(props.volume).toBeGreaterThan(Math.PI * 100 * 20 * 0.95);
    expect(props.volume).toBeLessThan(Math.PI * 100 * 20 * 1.001);
  });

  it('refuses an STL too big to sew', async () => {
    const bytes = new Uint8Array(84 + 50 * 60_000);
    new DataView(bytes.buffer).setUint32(80, 60_000, true);
    await expect(kernel.importStl(bytes)).rejects.toThrow(/60,000 triangles/);
  });
});

describe('orientation', () => {
  it('lays a T-shaped part on its flat top rather than balancing it on the stem', async () => {
    // A wide flat bar with a narrow stem standing on it: as modelled the stem is UP.
    const bar = await kernel.makeBox({ dx: 60, dy: 20, dz: 4 });
    const stem = await kernel.makeBox({ dx: 6, dy: 20, dz: 30, origin: { x: 27, y: 0, z: 4 } });
    const tee = await kernel.boolean('union', bar.handle, stem.handle);
    const [best] = await kernel.scoreOrientations(tee.handle, { maxOverhangDeg: 45, layer: 0.2 });
    expect(best!.down[2]).toBeCloseTo(-1, 3);
    expect(best!.overhangArea).toBe(0);
    expect(best!.contactArea).toBeCloseTo(1200, 1);
    // Upside down would be the worst of the axis candidates: the bar hangs off the stem.
    const all = await kernel.scoreOrientations(tee.handle, { maxOverhangDeg: 45, layer: 0.2, limit: 20 });
    const flipped = all.find((s) => s.down[2] > 0.999)!;
    expect(flipped.supportVolume).toBeGreaterThan(30_000);
  });
});
