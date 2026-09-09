/** Millimetres, degrees, Z-up, right-handed — see docs/adr and the project conventions. */

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface Bounds {
  readonly min: Vec3;
  readonly max: Vec3;
}

export const boundsCenter = (b: Bounds): Vec3 => ({
  x: (b.min.x + b.max.x) / 2,
  y: (b.min.y + b.max.y) / 2,
  z: (b.min.z + b.max.z) / 2,
});

export const boundsSize = (b: Bounds): Vec3 => ({
  x: b.max.x - b.min.x,
  y: b.max.y - b.min.y,
  z: b.max.z - b.min.z,
});

/** Half the space diagonal — the radius of the enclosing sphere. */
export function boundsRadius(b: Bounds): number {
  const s = boundsSize(b);
  return Math.hypot(s.x, s.y, s.z) / 2;
}

export function isFiniteBounds(b: Bounds): boolean {
  return [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].every(Number.isFinite);
}
