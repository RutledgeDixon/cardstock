import { beforeAll, describe, expect, it } from 'vitest';
import type { ProfileSpec } from '@cardstock/types';
import { createOcctKernel } from './session.js';
import type { OcctKernel } from './kernel.js';

/**
 * Revolve, shell and mirror against real geometry, checked against closed-form volumes.
 */
let kernel: OcctKernel;
beforeAll(async () => { kernel = await createOcctKernel(); }, 60_000);

const XZ: ProfileSpec['placement'] = {
  origin: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: -1, z: 0 },
  xAxis: { x: 1, y: 0, z: 0 },
};

/** A rectangle offset from the Z axis, so revolving it makes a tube. */
const offsetRectangle = (inner: number, width: number, height: number) => ({
  signedArea: width * height,
  segments: [
    { kind: 'line' as const, from: { x: inner, y: 0 }, to: { x: inner + width, y: 0 } },
    { kind: 'line' as const, from: { x: inner + width, y: 0 }, to: { x: inner + width, y: height } },
    { kind: 'line' as const, from: { x: inner + width, y: height }, to: { x: inner, y: height } },
    { kind: 'line' as const, from: { x: inner, y: height }, to: { x: inner, y: 0 } },
  ],
});

const Z_AXIS = { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 } };

describe('revolve', () => {
  it('turns an offset rectangle into a tube of the expected volume', async () => {
    const face = await kernel.makeFace({ placement: XZ, loops: [offsetRectangle(10, 5, 8)] });
    const { handle } = await kernel.revolve(face.handle, Z_AXIS, 360);
    // A ring: pi * (outer^2 - inner^2) * height.
    expect((await kernel.massProperties(handle)).volume)
      .toBeCloseTo(Math.PI * (15 * 15 - 10 * 10) * 8, 2);
  });

  it('makes a partial revolve proportional to its angle', async () => {
    const face = await kernel.makeFace({ placement: XZ, loops: [offsetRectangle(10, 5, 8)] });
    const full = await kernel.revolve(face.handle, Z_AXIS, 360);
    const quarter = await kernel.revolve(face.handle, Z_AXIS, 90);
    const fullVolume = (await kernel.massProperties(full.handle)).volume;
    expect((await kernel.massProperties(quarter.handle)).volume)
      .toBeCloseTo(fullVolume / 4, 3);
  });

  it('refuses a zero or oversized angle', async () => {
    const face = await kernel.makeFace({ placement: XZ, loops: [offsetRectangle(10, 5, 8)] });
    await expect(kernel.revolve(face.handle, Z_AXIS, 0)).rejects.toThrow(/must not be zero/);
    await expect(kernel.revolve(face.handle, Z_AXIS, 720)).rejects.toThrow(/cannot exceed 360/);
  });

  it('records history, so a reference into the profile survives', async () => {
    const face = await kernel.makeFace({ placement: XZ, loops: [offsetRectangle(10, 5, 8)] });
    const { history } = await kernel.revolve(face.handle, Z_AXIS, 360);
    expect(history!.inputs[0]!.generatedFaces.size).toBeGreaterThan(0);
  });
});

describe('shell', () => {
  it('hollows a box, leaving a wall of the given thickness', async () => {
    const box = await kernel.makeBox({ dx: 40, dy: 30, dz: 20 });
    // Open the top face, so it becomes an open tray.
    const description = await kernel.describeShape(box.handle);
    const top = description.faces.find((f) => f.direction!.z > 0.99)!;
    const { handle } = await kernel.shell(box.handle, [top.index], -2);

    const volume = (await kernel.massProperties(handle)).volume;
    // Solid minus the cavity: 40x30x20 less an inner 36x26x18 box open at the top.
    expect(volume).toBeCloseTo(40 * 30 * 20 - 36 * 26 * 18, 1);
  });

  it('refuses a face that does not exist', async () => {
    const box = await kernel.makeBox({ dx: 10, dy: 10, dz: 10 });
    await expect(kernel.shell(box.handle, [99], -1))
      .rejects.toThrow(/face 99 does not exist \(shape has 6\)/);
  });

  it('refuses a zero thickness', async () => {
    const box = await kernel.makeBox({ dx: 10, dy: 10, dz: 10 });
    await expect(kernel.shell(box.handle, [0], 0)).rejects.toThrow(/must not be zero/);
  });
});

describe('mirror', () => {
  it('reflects a shape through a plane, preserving its volume', async () => {
    const box = await kernel.makeBox({ dx: 10, dy: 10, dz: 10, origin: { x: 5, y: 0, z: 0 } });
    const { handle } = await kernel.mirror(box.handle, {
      origin: { x: 0, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 },
    });
    const bounds = await kernel.boundingBox(handle);
    expect(bounds.min.x).toBeCloseTo(-15, 6);
    expect(bounds.max.x).toBeCloseTo(-5, 6);
    expect((await kernel.massProperties(handle)).volume).toBeCloseTo(1000, 6);
  });

  it('leaves a shape straddling the mirror plane spanning both sides', async () => {
    const box = await kernel.makeBox({ dx: 10, dy: 10, dz: 10, origin: { x: -5, y: 0, z: 0 } });
    const { handle } = await kernel.mirror(box.handle, {
      origin: { x: 0, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 },
    });
    const bounds = await kernel.boundingBox(handle);
    expect(bounds.min.x).toBeCloseTo(-5, 6);
    expect(bounds.max.x).toBeCloseTo(5, 6);
  });
});
