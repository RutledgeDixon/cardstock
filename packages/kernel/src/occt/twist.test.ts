import { beforeAll, describe, expect, it } from 'vitest';
import type { ProfileSpec, ShapeHandle } from '@cardstock/types';
import type { OpenCascadeInstance } from 'replicad-opencascadejs';
import { createOcctKernel } from './session.js';
import type { OcctKernel } from './kernel.js';
import { subShapes } from './topology.js';

/**
 * Twisted extrude against real geometry.
 *
 * A twist leaves every cross-section the same shape and area, so the volume is exactly
 * the untwisted prism's (Cavalieri) — and the direction is checked by where the far
 * end's corners land, since "it made a solid" says nothing about which way it turned.
 */
let kernel: OcctKernel;
let oc: OpenCascadeInstance;
beforeAll(async () => {
  kernel = await createOcctKernel();
  oc = (kernel as unknown as { oc: OpenCascadeInstance }).oc;
}, 60_000);

const XY: ProfileSpec['placement'] = {
  origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, xAxis: { x: 1, y: 0, z: 0 },
};

/** A square of side 2*half centred at (cx, cy), counterclockwise. */
const square = (half: number, cx = 0, cy = 0) => ({
  signedArea: 4 * half * half,
  segments: [
    { kind: 'line' as const, from: { x: cx - half, y: cy - half }, to: { x: cx + half, y: cy - half } },
    { kind: 'line' as const, from: { x: cx + half, y: cy - half }, to: { x: cx + half, y: cy + half } },
    { kind: 'line' as const, from: { x: cx + half, y: cy + half }, to: { x: cx - half, y: cy + half } },
    { kind: 'line' as const, from: { x: cx - half, y: cy + half }, to: { x: cx - half, y: cy - half } },
  ],
});

/** Vertex positions, rounded, as "x,y,z" strings. */
function vertices(handle: ShapeHandle): Set<string> {
  const out = new Set<string>();
  for (const v of subShapes(oc, kernel.registry.get(handle), 'TopAbs_VERTEX')) {
    const p = oc.BRep_Tool.Pnt(oc.TopoDS.Vertex(v));
    const r = (n: number) => (Math.abs(n) < 0.005 ? 0 : n).toFixed(2);
    out.add(`${r(p.X())},${r(p.Y())},${r(p.Z())}`);
  }
  return out;
}

/**
 * Where (x, y) lands at height z after turning `degrees` counterclockwise about (cx, cy).
 *
 * The angles below are 30 degrees, never 45 or 90: a square looks the same turned a
 * quarter either way, so +45 and -45 put its corners in the same places and could not
 * tell a clockwise twist from a counterclockwise one.
 */
function turned(x: number, y: number, z: number, degrees: number, cx = 0, cy = 0): string {
  const a = (degrees * Math.PI) / 180;
  const dx = x - cx;
  const dy = y - cy;
  const r = (n: number) => (Math.abs(n) < 0.005 ? 0 : n).toFixed(2);
  return `${r(cx + dx * Math.cos(a) - dy * Math.sin(a))},${r(cy + dx * Math.sin(a) + dy * Math.cos(a))},${r(z)}`;
}

describe('twisted extrude', () => {
  it('turns the top counterclockwise about the profile centre, keeping the volume', async () => {
    // Off the origin on purpose: the twist is about the profile's own centre, (20, 0).
    const face = await kernel.makeFace({ placement: XY, loops: [square(5, 20, 0)] });
    const solid = await kernel.extrude(face.handle, 30, false, 30);

    expect((await kernel.massProperties(solid.handle)).volume).toBeCloseTo(100 * 30, 1);
    const v = vertices(solid.handle);
    // The bottom is the sketch as drawn; the top has turned counterclockwise seen from above.
    expect(v).toContain('25.00,-5.00,0.00');
    expect(v).toContain(turned(25, -5, 30, 30, 20, 0));
    expect(v).not.toContain(turned(25, -5, 30, -30, 20, 0));
  });

  it('turns clockwise for a negative twist', async () => {
    const face = await kernel.makeFace({ placement: XY, loops: [square(5)] });
    const v = vertices((await kernel.extrude(face.handle, 30, false, -30)).handle);
    expect(v).toContain(turned(5, -5, 30, -30));
    expect(v).not.toContain(turned(5, -5, 30, 30));
  });

  it('keeps a hole a hole', async () => {
    const face = await kernel.makeFace({
      placement: XY,
      loops: [square(10), { ...square(4), signedArea: -64 }],
    });
    const solid = await kernel.extrude(face.handle, 20, false, 90);
    expect((await kernel.massProperties(solid.handle)).volume).toBeCloseTo((400 - 64) * 20, 0);
  });

  it('twists relative to the extrude direction when extruding the other way', async () => {
    const face = await kernel.makeFace({ placement: XY, loops: [square(5)] });
    const solid = await kernel.extrude(face.handle, -30, false, 30);
    expect((await kernel.massProperties(solid.handle)).volume).toBeCloseTo(3000, 1);
    // Counterclockwise looking back from the far end (from below, up the -z axis) is
    // clockwise seen from above.
    expect(vertices(solid.handle)).toContain(turned(5, -5, -30, -30));
  });

  it('centres a symmetric twist on the sketch plane', async () => {
    const face = await kernel.makeFace({ placement: XY, loops: [square(5)] });
    const v = vertices((await kernel.extrude(face.handle, 30, true, 60)).handle);
    // -30 degrees at the bottom, +30 at the top: 60 from end to end.
    expect(v).toContain(turned(5, -5, -15, -30));
    expect(v).toContain(turned(5, -5, 15, 30));
  });

  it('works on a plane other than XY', async () => {
    const XZ: ProfileSpec['placement'] = {
      origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: -1, z: 0 }, xAxis: { x: 1, y: 0, z: 0 },
    };
    const face = await kernel.makeFace({ placement: XZ, loops: [square(5)] });
    const solid = await kernel.extrude(face.handle, 20, false, 30);
    expect((await kernel.massProperties(solid.handle)).volume).toBeCloseTo(100 * 20, 1);
  });

  it('leaves an untwisted extrude exactly as it was', async () => {
    const face = await kernel.makeFace({ placement: XY, loops: [square(5)] });
    const solid = await kernel.extrude(face.handle, 30, false, 0);
    // The plain prism still reports history, which the twisted sweep does not.
    expect(solid.history).toBeDefined();
    expect(subShapes(oc, kernel.registry.get(solid.handle), 'TopAbs_FACE')).toHaveLength(6);
  });
});
