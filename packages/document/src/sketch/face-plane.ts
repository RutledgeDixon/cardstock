import type { EntityFingerprint, PlanePlacement, ShapeDescription, Vec3 } from '@cardstock/types';

/**
 * Turn a planar face into a sketch plane.
 *
 * The face gives an origin and a normal; the in-plane X direction has to be invented,
 * and the only thing that matters is that the SAME face always yields the SAME X — a
 * sketch whose axes rotate when the model rebuilds would move everything drawn on it.
 * So X is derived deterministically from the normal rather than from anything about the
 * face's boundary, which can change under editing.
 */
export function placementForFace(face: EntityFingerprint): PlanePlacement | null {
  if (!face.direction) return null;
  const normal = normalise(face.direction);
  if (normal === null) return null;

  // Cross with whichever world axis is least parallel to the normal: the most
  // numerically stable choice, and a deterministic function of the normal alone.
  const axes: Vec3[] = [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }];
  const reference = axes.reduce((least, axis) =>
    Math.abs(dot(axis, normal)) < Math.abs(dot(least, normal)) ? axis : least);

  const xAxis = normalise(cross(reference, normal));
  if (xAxis === null) return null;

  return { origin: face.centroid, normal, xAxis };
}

/** The placement for a face index within a shape description. */
export function placementForFaceIndex(
  description: ShapeDescription,
  index: number,
): PlanePlacement | null {
  const face = description.faces.find((f) => f.index === index);
  return face ? placementForFace(face) : null;
}

const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

function normalise(v: Vec3): Vec3 | null {
  const length = Math.hypot(v.x, v.y, v.z);
  if (length < 1e-9) return null;
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}
