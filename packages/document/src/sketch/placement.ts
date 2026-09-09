import type { PlanePlacement } from '@cardstock/types';
import type { SketchPlane } from './sketch.js';

/**
 * Where a sketch plane sits in 3D.
 *
 * The in-plane Y direction is `normal × xAxis`, so the normal is chosen to make sketch-up
 * point the way a person expects rather than to point "outward" in some abstract sense.
 * On XZ that means -Y: with +Y, sketch-up would map to world -Z and everything drawn
 * would come out upside down.
 */
export const ORIGIN_PLANES: Readonly<Record<'xy' | 'xz' | 'yz', PlanePlacement>> = {
  xy: {
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
    xAxis: { x: 1, y: 0, z: 0 },
  },
  xz: {
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: -1, z: 0 }, // so sketch-up is +Z
    xAxis: { x: 1, y: 0, z: 0 },
  },
  yz: {
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 1, y: 0, z: 0 },
    xAxis: { x: 0, y: 1, z: 0 }, // so sketch-up is +Z
  },
};

/**
 * Resolve a sketch plane to a placement.
 *
 * A face-based plane needs the face's own placement, which only the kernel can supply;
 * `faceLookup` is how the caller provides it. Returning null rather than falling back to
 * XY matters: silently sketching on the wrong plane is far worse than refusing.
 */
export function resolvePlacement(
  plane: SketchPlane,
  faceLookup?: (ref: SketchPlane extends { ref: infer R } ? R : never) => PlanePlacement | null,
): PlanePlacement | null {
  if (plane.kind === 'origin') return ORIGIN_PLANES[plane.plane];
  if (!faceLookup) return null;
  return faceLookup(plane.ref as never);
}

/** Sketch coordinates to 3D, for drawing and picking. */
export function toWorld(
  placement: PlanePlacement,
  point: { x: number; y: number },
): { x: number; y: number; z: number } {
  const y = cross(placement.normal, placement.xAxis);
  return {
    x: placement.origin.x + placement.xAxis.x * point.x + y.x * point.y,
    y: placement.origin.y + placement.xAxis.y * point.x + y.y * point.y,
    z: placement.origin.z + placement.xAxis.z * point.x + y.z * point.y,
  };
}

/** 3D back to sketch coordinates, for turning a pick into a sketch position. */
export function toSketch(
  placement: PlanePlacement,
  point: { x: number; y: number; z: number },
): { x: number; y: number } {
  const yAxis = cross(placement.normal, placement.xAxis);
  const d = {
    x: point.x - placement.origin.x,
    y: point.y - placement.origin.y,
    z: point.z - placement.origin.z,
  };
  return { x: dot(d, placement.xAxis), y: dot(d, yAxis) };
}

const cross = (
  a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number },
) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

const dot = (
  a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number },
) => a.x * b.x + a.y * b.y + a.z * b.z;
