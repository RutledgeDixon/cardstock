import { describe, expect, it } from 'vitest';
import { ORIGIN_PLANES, resolvePlacement, toSketch, toWorld } from './placement.js';

describe('origin planes', () => {
  it('puts sketch-up along +Z on the vertical planes', () => {
    // The in-plane Y is normal x xAxis. Choosing +Y for XZ would map sketch-up to world
    // -Z and everything drawn would come out upside down.
    expect(toWorld(ORIGIN_PLANES.xz, { x: 0, y: 5 })).toMatchObject({ z: 5 });
    expect(toWorld(ORIGIN_PLANES.yz, { x: 0, y: 5 })).toMatchObject({ z: 5 });
  });

  it('puts sketch-right along the expected world axis', () => {
    expect(toWorld(ORIGIN_PLANES.xy, { x: 7, y: 0 })).toMatchObject({ x: 7, y: 0, z: 0 });
    expect(toWorld(ORIGIN_PLANES.xz, { x: 7, y: 0 })).toMatchObject({ x: 7, z: 0 });
    expect(toWorld(ORIGIN_PLANES.yz, { x: 7, y: 0 })).toMatchObject({ y: 7, z: 0 });
  });

  it('keeps XY as the identity mapping', () => {
    expect(toWorld(ORIGIN_PLANES.xy, { x: 3, y: 4 })).toEqual({ x: 3, y: 4, z: 0 });
  });
});

describe('round trips', () => {
  it('maps sketch to world and back for every origin plane', () => {
    for (const placement of Object.values(ORIGIN_PLANES)) {
      for (const point of [{ x: 0, y: 0 }, { x: 12.5, y: -3 }, { x: -7, y: 9 }]) {
        const back = toSketch(placement, toWorld(placement, point));
        expect(back.x).toBeCloseTo(point.x, 9);
        expect(back.y).toBeCloseTo(point.y, 9);
      }
    }
  });

  it('round-trips on an offset plane', () => {
    const placement = {
      origin: { x: 10, y: -4, z: 6 },
      normal: { x: 0, y: 0, z: 1 },
      xAxis: { x: 1, y: 0, z: 0 },
    };
    const back = toSketch(placement, toWorld(placement, { x: 2, y: 3 }));
    expect(back).toEqual({ x: 2, y: 3 });
  });
});

describe('resolution', () => {
  it('resolves an origin plane without help', () => {
    expect(resolvePlacement({ kind: 'origin', plane: 'xy' })).toEqual(ORIGIN_PLANES.xy);
  });

  it('refuses a face plane when no lookup is available', () => {
    // Falling back to XY would silently sketch on the wrong plane, which is far worse
    // than refusing to sketch at all.
    const ref = { kind: 'face', origin: { featureId: 'f', index: 0 }, fingerprint: {} } as never;
    expect(resolvePlacement({ kind: 'face', ref })).toBeNull();
  });

  it('uses the lookup for a face plane', () => {
    const ref = { kind: 'face', origin: { featureId: 'f', index: 2 }, fingerprint: {} } as never;
    const placement = ORIGIN_PLANES.xz;
    expect(resolvePlacement({ kind: 'face', ref }, () => placement)).toBe(placement);
  });
});
