import { describe, expect, it } from 'vitest';
import { weld, triangleCount, signedVolume, isWatertight, type ExportMesh } from './mesh.js';
import { encodeStlBinary, encodeStlAscii } from './stl.js';
import { encodeObj } from './obj.js';
import { encode3mf } from './threemf.js';
import { crc32, zipEntryNames, zipStore } from './zip.js';

/**
 * A unit cube as the tessellator would hand it over: four vertices per face, six
 * faces, so 24 vertices where a closed mesh has 8. Wound outward.
 */
function unwelded(): { positions: number[]; indices: number[] } {
  const positions: number[] = [];
  const indices: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[]) => {
    const base = positions.length / 3;
    positions.push(...a, ...b, ...c, ...d);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  quad([0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]); // bottom, normal -z
  quad([0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]); // top, +z
  quad([0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]); // front, -y
  quad([0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]); // back, +y
  quad([0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]); // left, -x
  quad([1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]); // right, +x
  return { positions, indices };
}

const cube = (): ExportMesh => { const u = unwelded(); return weld(u.positions, u.indices); };

describe('weld', () => {
  it('merges vertices shared between faces into a closed mesh', () => {
    const mesh = cube();
    expect(mesh.positions.length / 3).toBe(8);
    expect(triangleCount(mesh)).toBe(12);
    expect(isWatertight(mesh)).toBe(true);
    expect(signedVolume(mesh)).toBeCloseTo(1, 9);
  });

  it('drops triangles that collapse, and sees an open mesh for what it is', () => {
    const u = unwelded();
    const missingTop = weld(u.positions, u.indices.slice(0, 6 * 5));
    expect(isWatertight(missingTop)).toBe(false);
    const collapsed = weld([0, 0, 0, 0, 0, 0.00001, 1, 0, 0], [0, 1, 2]);
    expect(triangleCount(collapsed)).toBe(0);
  });
});

describe('STL', () => {
  it('binary length matches the count and normals face outward', () => {
    const bytes = encodeStlBinary(cube(), 'cube');
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(80, true)).toBe(12);
    expect(bytes.length).toBe(84 + 12 * 50);
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).not.toBe('solid');
    // First triangle is on the bottom face: normal -z.
    expect(view.getFloat32(84 + 8, true)).toBeCloseTo(-1);
  });

  it('ascii has one facet per triangle', () => {
    const text = new TextDecoder().decode(encodeStlAscii(cube(), 'cube'));
    expect(text.startsWith('solid cube')).toBe(true);
    expect(text.match(/facet normal/g)).toHaveLength(12);
    expect(text.trimEnd().endsWith('endsolid cube')).toBe(true);
  });
});

describe('OBJ', () => {
  it('writes 8 vertices and 12 one-based faces', () => {
    const text = new TextDecoder().decode(encodeObj(cube(), 'cube'));
    expect(text.match(/^v /gm)).toHaveLength(8);
    expect(text.match(/^f /gm)).toHaveLength(12);
    expect(text).not.toMatch(/^f .*\b0\b/m);
    expect(text).toContain('o cube');
  });
});

describe('ZIP', () => {
  it('crc32 matches the reference value for "123456789"', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('stores entries that can be walked back', () => {
    const bytes = zipStore([
      { name: 'a.txt', data: new TextEncoder().encode('hello') },
      { name: 'dir/b.txt', data: new TextEncoder().encode('world!') },
    ]);
    expect(zipEntryNames(bytes)).toEqual(['a.txt', 'dir/b.txt']);
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(bytes.length - 22, true)).toBe(0x06054b50);
    expect(view.getUint16(bytes.length - 22 + 10, true)).toBe(2);
  });
});

describe('3MF', () => {
  it('is a zip with the three required parts and an indexed millimetre mesh', () => {
    const bytes = encode3mf(cube(), 'cube');
    expect(zipEntryNames(bytes)).toEqual(['[Content_Types].xml', '_rels/.rels', '3D/3dmodel.model']);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('unit="millimeter"');
    expect(text.match(/<vertex /g)).toHaveLength(8);
    expect(text.match(/<triangle /g)).toHaveLength(12);
    expect(text).toContain('<item objectid="1"/>');
  });
});
