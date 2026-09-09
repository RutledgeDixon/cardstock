import { beforeAll, describe, expect, it } from 'vitest';
import type { ProfileSpec } from '@cardstock/types';
import { createOcctKernel } from './session.js';
import type { OcctKernel } from './kernel.js';

/**
 * Sketch profiles becoming real faces and solids.
 *
 * Areas and volumes are checked against closed-form values, so a wrong winding or a hole
 * added as a separate region shows up as the wrong number rather than as a shape that
 * merely looks plausible.
 */
let kernel: OcctKernel;
beforeAll(async () => { kernel = await createOcctKernel(); }, 60_000);

const XY: ProfileSpec['placement'] = {
  origin: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
  xAxis: { x: 1, y: 0, z: 0 },
};

const rectangleLoop = (w: number, h: number) => ({
  signedArea: w * h,
  segments: [
    { kind: 'line' as const, from: { x: 0, y: 0 }, to: { x: w, y: 0 } },
    { kind: 'line' as const, from: { x: w, y: 0 }, to: { x: w, y: h } },
    { kind: 'line' as const, from: { x: w, y: h }, to: { x: 0, y: h } },
    { kind: 'line' as const, from: { x: 0, y: h }, to: { x: 0, y: 0 } },
  ],
});

const circleLoop = (cx: number, cy: number, r: number) => ({
  signedArea: Math.PI * r * r,
  segments: [{ kind: 'circle' as const, centre: { x: cx, y: cy }, radius: r }],
});

describe('faces from profiles', () => {
  it('builds a rectangle with the right area', async () => {
    const { handle } = await kernel.makeFace({ placement: XY, loops: [rectangleLoop(40, 20)] });
    const mass = await kernel.massProperties(handle);
    expect(mass.surfaceArea).toBeCloseTo(800, 6);
    expect(await kernel.topologyCounts(handle)).toMatchObject({ faces: 1, edges: 4 });
  });

  it('builds a disc from a single circle segment', async () => {
    const { handle } = await kernel.makeFace({ placement: XY, loops: [circleLoop(0, 0, 5)] });
    expect((await kernel.massProperties(handle)).surfaceArea).toBeCloseTo(Math.PI * 25, 4);
  });

  it('subtracts later loops as holes rather than adding them as regions', async () => {
    // If the hole wire is not reversed, OCCT adds it as a second region and the area
    // comes out too large — a face that looks right until you extrude it.
    const { handle } = await kernel.makeFace({
      placement: XY,
      loops: [rectangleLoop(40, 20), circleLoop(20, 10, 4)],
    });
    const mass = await kernel.massProperties(handle);
    expect(mass.surfaceArea).toBeCloseTo(800 - Math.PI * 16, 4);
  });

  it('honours the plane placement', async () => {
    const { handle } = await kernel.makeFace({
      placement: {
        origin: { x: 0, y: 0, z: 12 },
        normal: { x: 0, y: 0, z: 1 },
        xAxis: { x: 1, y: 0, z: 0 },
      },
      loops: [rectangleLoop(10, 10)],
    });
    const bounds = await kernel.boundingBox(handle);
    expect(bounds.min.z).toBeCloseTo(12, 6);
    expect(bounds.max.z).toBeCloseTo(12, 6);
  });

  it('places a sketch on a vertical plane', async () => {
    // The plane's in-plane Y is normal x xAxis, so with normal +Y and xAxis +X the
    // sketch's up maps to world -Z. Which normal an "XZ plane" should use is a naming
    // decision that belongs where planes are named, not here; the kernel's job is only
    // to honour the placement it is handed.
    const { handle } = await kernel.makeFace({
      placement: {
        origin: { x: 0, y: 0, z: 0 },
        normal: { x: 0, y: 1, z: 0 },
        xAxis: { x: 1, y: 0, z: 0 },
      },
      loops: [rectangleLoop(10, 6)],
    });
    const bounds = await kernel.boundingBox(handle);
    expect(bounds.max.y).toBeCloseTo(0, 6);          // flat in the plane
    expect(bounds.max.x - bounds.min.x).toBeCloseTo(10, 6);
    expect(bounds.max.z - bounds.min.z).toBeCloseTo(6, 6);
  });

  it('flips the sketch up-direction when the normal is flipped', async () => {
    const up = await kernel.makeFace({
      placement: {
        origin: { x: 0, y: 0, z: 0 },
        normal: { x: 0, y: -1, z: 0 },
        xAxis: { x: 1, y: 0, z: 0 },
      },
      loops: [rectangleLoop(10, 6)],
    });
    // With normal -Y, sketch up becomes world +Z: the convention an "XZ plane" wants.
    const bounds = await kernel.boundingBox(up.handle);
    expect(bounds.min.z).toBeCloseTo(0, 6);
    expect(bounds.max.z).toBeCloseTo(6, 6);
  });

  it('refuses an empty profile', async () => {
    await expect(kernel.makeFace({ placement: XY, loops: [] }))
      .rejects.toThrow(/at least one closed loop/);
  });
});

describe('extruding', () => {
  it('sweeps a rectangle into a box of the expected volume', async () => {
    const face = await kernel.makeFace({ placement: XY, loops: [rectangleLoop(40, 20)] });
    const { handle } = await kernel.extrude(face.handle, 15);
    expect((await kernel.massProperties(handle)).volume).toBeCloseTo(800 * 15, 4);
    expect(await kernel.topologyCounts(handle)).toMatchObject({ faces: 6 });
  });

  it('carries a hole through the extrusion', async () => {
    const face = await kernel.makeFace({
      placement: XY, loops: [rectangleLoop(40, 20), circleLoop(20, 10, 4)],
    });
    const { handle } = await kernel.extrude(face.handle, 10);
    expect((await kernel.massProperties(handle)).volume)
      .toBeCloseTo((800 - Math.PI * 16) * 10, 3);
  });

  it('extrudes the other way for a negative distance', async () => {
    const face = await kernel.makeFace({ placement: XY, loops: [rectangleLoop(10, 10)] });
    const { handle } = await kernel.extrude(face.handle, -8);
    const bounds = await kernel.boundingBox(handle);
    expect(bounds.min.z).toBeCloseTo(-8, 6);
    expect(bounds.max.z).toBeCloseTo(0, 6);
  });

  it('straddles the sketch plane when symmetric', async () => {
    const face = await kernel.makeFace({ placement: XY, loops: [rectangleLoop(10, 10)] });
    const { handle } = await kernel.extrude(face.handle, 20, true);
    const bounds = await kernel.boundingBox(handle);
    expect(bounds.min.z).toBeCloseTo(-10, 6);
    expect(bounds.max.z).toBeCloseTo(10, 6);
    expect((await kernel.massProperties(handle)).volume).toBeCloseTo(2000, 6);
  });

  it('follows the sketch plane rather than the world axes', async () => {
    // An extrude that ignored the face normal would come out skewed relative to the
    // sketch it grew from.
    const face = await kernel.makeFace({
      placement: {
        origin: { x: 0, y: 0, z: 0 },
        normal: { x: 0, y: 1, z: 0 },
        xAxis: { x: 1, y: 0, z: 0 },
      },
      loops: [rectangleLoop(10, 6)],
    });
    const { handle } = await kernel.extrude(face.handle, 5);
    const bounds = await kernel.boundingBox(handle);
    expect(Math.abs(bounds.max.y - bounds.min.y)).toBeCloseTo(5, 6);
    expect((await kernel.massProperties(handle)).volume).toBeCloseTo(300, 5);
  });

  it('refuses a zero distance', async () => {
    const face = await kernel.makeFace({ placement: XY, loops: [rectangleLoop(10, 10)] });
    await expect(kernel.extrude(face.handle, 0)).rejects.toThrow(/must not be zero/);
  });

  it('records history, so a reference to a sketch edge can survive', async () => {
    const face = await kernel.makeFace({ placement: XY, loops: [rectangleLoop(10, 10)] });
    const { history } = await kernel.extrude(face.handle, 5);
    expect(history).toBeDefined();
    // Each boundary edge generates a side face.
    expect(history!.inputs[0]!.generatedFaces.size).toBeGreaterThan(0);
  });
});
