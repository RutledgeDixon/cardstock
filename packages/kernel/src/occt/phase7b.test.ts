import { beforeAll, describe, expect, it } from 'vitest';
import type { ProfileSpec } from '@cardstock/types';
import { createOcctKernel } from './session.js';
import type { OcctKernel } from './kernel.js';

/**
 * Sweep, loft and draft against real geometry.
 *
 * Volumes are checked against closed forms where one exists, because "it produced a
 * shape" is not evidence that it produced the right one.
 */
let kernel: OcctKernel;
beforeAll(async () => { kernel = await createOcctKernel(); }, 60_000);

const XY: ProfileSpec['placement'] = {
  origin: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
  xAxis: { x: 1, y: 0, z: 0 },
};

const planeAt = (z: number): ProfileSpec['placement'] => ({
  origin: { x: 0, y: 0, z },
  normal: { x: 0, y: 0, z: 1 },
  xAxis: { x: 1, y: 0, z: 0 },
});

const square = (half: number) => ({
  signedArea: 4 * half * half,
  segments: [
    { kind: 'line' as const, from: { x: -half, y: -half }, to: { x: half, y: -half } },
    { kind: 'line' as const, from: { x: half, y: -half }, to: { x: half, y: half } },
    { kind: 'line' as const, from: { x: half, y: half }, to: { x: -half, y: half } },
    { kind: 'line' as const, from: { x: -half, y: half }, to: { x: -half, y: -half } },
  ],
});

const circle = (radius: number) => ({
  signedArea: Math.PI * radius * radius,
  segments: [{ kind: 'circle' as const, centre: { x: 0, y: 0 }, radius }],
});

/** An open path in the XZ plane, so it leaves the profile's own plane. */
const XZ: ProfileSpec['placement'] = {
  origin: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: -1, z: 0 },
  xAxis: { x: 1, y: 0, z: 0 },
};

describe('sweep', () => {
  it('sweeping a square along a straight path matches a prism', async () => {
    const profile = await kernel.makeFace({ placement: XY, loops: [square(5)] });
    // Straight up from the profile's own plane: the same solid an extrude would make,
    // which is the only case with a volume known in closed form.
    const path = await kernel.makePath({
      placement: XZ,
      loops: [{
        signedArea: 0,
        segments: [{ kind: 'line', from: { x: 0, y: 0 }, to: { x: 0, y: 30 } }],
      }],
    });
    const swept = await kernel.sweep(profile.handle, path.handle);
    expect((await kernel.massProperties(swept.handle)).volume)
      .toBeCloseTo(10 * 10 * 30, 2);
  });

  it('follows a bent path, which is the whole point of a sweep', async () => {
    const profile = await kernel.makeFace({ placement: XY, loops: [square(2)] });
    const path = await kernel.makePath({
      placement: XZ,
      loops: [{
        signedArea: 0,
        segments: [
          { kind: 'line', from: { x: 0, y: 0 }, to: { x: 0, y: 20 } },
          { kind: 'line', from: { x: 0, y: 20 }, to: { x: 15, y: 20 } },
        ],
      }],
    });
    const swept = await kernel.sweep(profile.handle, path.handle);
    // Exactly the path length times the section: the RightCorner transition mitres the
    // bend rather than overlapping or gapping the two legs.
    expect((await kernel.massProperties(swept.handle)).volume)
      .toBeCloseTo(4 * 4 * (20 + 15), 4);
  });

  it('takes a closed path from a face boundary and matches Pappus', async () => {
    // The path here is a FACE — a sketched circle — and the sweep has to find its wire.
    const path = await kernel.makeFace({ placement: XY, loops: [circle(20)] });
    const profile = await kernel.makeFace({
      placement: { origin: { x: 20, y: 0, z: 0 }, normal: { x: 0, y: -1, z: 0 }, xAxis: { x: 1, y: 0, z: 0 } },
      loops: [square(1)],
    });
    const swept = await kernel.sweep(profile.handle, path.handle);
    // Pappus: section area times the distance its centroid travels.
    expect((await kernel.massProperties(swept.handle)).volume)
      .toBeCloseTo(4 * 2 * Math.PI * 20, 0);
  });

  it('reports a sweep that cannot close rather than returning a bad solid', async () => {
    // A profile far larger than the loop it is swept around self-intersects.
    const profile = await kernel.makeFace({ placement: XY, loops: [square(50)] });
    const path = await kernel.makeFace({ placement: XY, loops: [square(2)] });
    await expect(kernel.sweep(profile.handle, path.handle)).rejects.toThrow(/sweep/);
  });
});

describe('loft', () => {
  it('blends two equal squares into a prism of the exact volume', async () => {
    const bottom = await kernel.makeFace({ placement: planeAt(0), loops: [square(5)] });
    const top = await kernel.makeFace({ placement: planeAt(20), loops: [square(5)] });
    const { handle } = await kernel.loft([bottom.handle, top.handle], { ruled: true });
    expect((await kernel.massProperties(handle)).volume).toBeCloseTo(10 * 10 * 20, 4);
  });

  it('blends a square into a smaller square as a ruled frustum', async () => {
    const bottom = await kernel.makeFace({ placement: planeAt(0), loops: [square(5)] });
    const top = await kernel.makeFace({ placement: planeAt(12), loops: [square(2)] });
    const { handle } = await kernel.loft([bottom.handle, top.handle], { ruled: true });
    // Prismatoid rule: h/6 * (A1 + 4*Am + A2), exact for a frustum.
    const a1 = 100, a2 = 16, am = 7 * 7;
    expect((await kernel.massProperties(handle)).volume)
      .toBeCloseTo((12 / 6) * (a1 + 4 * am + a2), 2);
  });

  it('lofts a circle to a square', async () => {
    const bottom = await kernel.makeFace({ placement: planeAt(0), loops: [circle(6)] });
    const top = await kernel.makeFace({ placement: planeAt(10), loops: [square(4)] });
    const { handle } = await kernel.loft([bottom.handle, top.handle]);
    const { volume } = await kernel.massProperties(handle);
    // Bounded by the two section areas times the height.
    expect(volume).toBeGreaterThan(Math.min(Math.PI * 36, 64) * 10);
    expect(volume).toBeLessThan(Math.max(Math.PI * 36, 64) * 10);
  });

  it('refuses a single profile', async () => {
    const only = await kernel.makeFace({ placement: XY, loops: [square(5)] });
    await expect(kernel.loft([only.handle])).rejects.toThrow(/at least two/);
  });
});

describe('draft', () => {
  const Z_UP = { x: 0, y: 0, z: 1 };
  const BASE = { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 } };

  it('tapering the sides of a box removes material', async () => {
    const box = await kernel.makeBox({ dx: 20, dy: 20, dz: 20, origin: { x: -10, y: -10, z: 0 } });
    const before = (await kernel.massProperties(box.handle)).volume;
    const faces = await kernel.describeShape(box.handle);
    // Every planar face whose normal is horizontal is a side.
    const sides = faces.faces
      .map((f, i) => ({ f, i }))
      .filter(({ f }) => Math.abs(f.direction?.z ?? 1) < 1e-6)
      .map(({ i }) => i);
    expect(sides).toHaveLength(4);

    const drafted = await kernel.draft(box.handle, sides, 5, Z_UP, BASE);
    const after = (await kernel.massProperties(drafted.handle)).volume;
    expect(after).toBeLessThan(before);
    // A 5-degree taper over 20mm pulls each side in by 20*tan(5) at the top.
    expect(before - after).toBeGreaterThan(0);
  });

  it('names the face it cannot taper', async () => {
    const sphere = await kernel.makeSphere({ radius: 10 });
    await expect(kernel.draft(sphere.handle, [0], 5, Z_UP, BASE))
      .rejects.toThrow(/face 0/);
  });

  it('rejects a face index that does not exist', async () => {
    const box = await kernel.makeBox({ dx: 10, dy: 10, dz: 10 });
    await expect(kernel.draft(box.handle, [99], 5, Z_UP, BASE))
      .rejects.toThrow(/does not exist/);
  });

  it('rejects a zero angle', async () => {
    const box = await kernel.makeBox({ dx: 10, dy: 10, dz: 10 });
    await expect(kernel.draft(box.handle, [0], 0, Z_UP, BASE))
      .rejects.toThrow(/must not be zero/);
  });
});
