import { describe, expect, it } from 'vitest';
import type { EntityFingerprint, Vec3 } from '@cardstock/types';
import { placementForFace } from './face-plane.js';

const face = (normal: Vec3 | null, centroid: Vec3 = { x: 0, y: 0, z: 0 }): EntityFingerprint => ({
  kind: 'face', index: 0, geometryType: 'plane',
  centroid, centroidNormalised: { x: 0.5, y: 0.5, z: 0.5 },
  direction: normal, measure: 1, measureRatio: 1, neighbourTypes: [],
});

const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const length = (v: Vec3) => Math.hypot(v.x, v.y, v.z);

describe('a face becomes a sketch plane', () => {
  it('puts the origin at the face centre and keeps the face normal', () => {
    const placement = placementForFace(face({ x: 0, y: 0, z: 1 }, { x: 5, y: 6, z: 7 }))!;
    expect(placement.origin).toEqual({ x: 5, y: 6, z: 7 });
    expect(placement.normal.z).toBeCloseTo(1, 9);
  });

  it('produces a unit X axis perpendicular to the normal, for any orientation', () => {
    const normals: Vec3[] = [
      { x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 0 }, { x: 0, y: -1, z: 0 },
      { x: 1, y: 1, z: 1 }, { x: -3, y: 0.5, z: 2 }, { x: 0.001, y: 0, z: 1 },
    ];
    for (const normal of normals) {
      const placement = placementForFace(face(normal))!;
      expect(length(placement.xAxis)).toBeCloseTo(1, 9);
      expect(length(placement.normal)).toBeCloseTo(1, 9);
      expect(dot(placement.xAxis, placement.normal)).toBeCloseTo(0, 9);
    }
  });

  it('gives the same axes for the same normal every time', () => {
    // A sketch whose axes rotate when the model rebuilds would move everything drawn on
    // it, so X must be a deterministic function of the normal alone.
    const a = placementForFace(face({ x: 0.3, y: -0.7, z: 0.5 }))!;
    const b = placementForFace(face({ x: 0.3, y: -0.7, z: 0.5 }))!;
    expect(a.xAxis).toEqual(b.xAxis);
  });

  it('is unaffected by the magnitude of the supplied normal', () => {
    const unit = placementForFace(face({ x: 0, y: 0, z: 1 }))!;
    const scaled = placementForFace(face({ x: 0, y: 0, z: 12 }))!;
    expect(scaled.xAxis.x).toBeCloseTo(unit.xAxis.x, 9);
    expect(scaled.normal.z).toBeCloseTo(1, 9);
  });

  it('refuses a face with no usable normal', () => {
    expect(placementForFace(face(null))).toBeNull();
    expect(placementForFace(face({ x: 0, y: 0, z: 0 }))).toBeNull();
  });
});
