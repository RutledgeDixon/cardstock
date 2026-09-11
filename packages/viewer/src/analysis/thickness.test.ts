import { describe, expect, it } from 'vitest';
import { BufferAttribute, BufferGeometry, Float32BufferAttribute, Mesh, MeshBasicMaterial } from 'three';
import { computeBoundsTree } from 'three-mesh-bvh';
import { computeVertexThickness } from './thickness.js';

/** A slab with one vertex run per face, wound outward, like the tessellator makes. */
function slab(dx: number, dy: number, dz: number): Mesh {
  const p: number[] = [], n: number[] = [], idx: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[], normal: number[]) => {
    const base = p.length / 3;
    p.push(...a, ...b, ...c, ...d);
    for (let i = 0; i < 4; i++) n.push(...normal);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  quad([0, 0, 0], [0, dy, 0], [dx, dy, 0], [dx, 0, 0], [0, 0, -1]);
  quad([0, 0, dz], [dx, 0, dz], [dx, dy, dz], [0, dy, dz], [0, 0, 1]);
  quad([0, 0, 0], [dx, 0, 0], [dx, 0, dz], [0, 0, dz], [0, -1, 0]);
  quad([0, dy, 0], [0, dy, dz], [dx, dy, dz], [dx, dy, 0], [0, 1, 0]);
  quad([0, 0, 0], [0, 0, dz], [0, dy, dz], [0, dy, 0], [-1, 0, 0]);
  quad([dx, 0, 0], [dx, dy, 0], [dx, dy, dz], [dx, 0, dz], [1, 0, 0]);
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(p, 3));
  g.setAttribute('normal', new Float32BufferAttribute(n, 3));
  g.setIndex(new BufferAttribute(Uint32Array.from(idx), 1));
  (g as BufferGeometry & { boundsTree?: unknown }).boundsTree = computeBoundsTree.call(g, { indirect: true });
  return new Mesh(g, new MeshBasicMaterial());
}

describe('vertex thickness', () => {
  it('measures a slab through its thin direction and never under-reports', () => {
    const t = computeVertexThickness(slab(30, 20, 2));
    const finite = [...t].filter((v) => v < Number.MAX_VALUE);
    expect(finite.length).toBeGreaterThan(0);
    // Top and bottom vertices look through 2 mm; sides look across 20 or 30.
    expect(Math.min(...finite)).toBeCloseTo(2, 2);
    expect(finite.every((v) => v >= 2 - 1e-3)).toBe(true);
    expect(finite.some((v) => v > 19)).toBe(true);
  });
});
