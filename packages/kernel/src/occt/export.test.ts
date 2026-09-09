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
  it('produces a well-formed file whose length matches its triangle count', async () => {
    const { handle } = await kernel.makeBox({ dx: 40, dy: 30, dz: 20 });
    const bytes = await kernel.exportStl(handle);
    expect(bytes.length).toBeGreaterThan(84);

    if (isAscii(bytes)) {
      const text = new TextDecoder().decode(bytes);
      expect(text).toMatch(/^solid/);
      expect(text).toMatch(/endsolid\s*$/);
      // A box is 12 triangles however it is tessellated.
      expect(text.match(/facet normal/g)).toHaveLength(12);
    } else {
      const { triangles, expectedLength } = readBinaryStl(bytes);
      expect(triangles).toBe(12);
      expect(bytes.length).toBe(expectedLength);
    }
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
