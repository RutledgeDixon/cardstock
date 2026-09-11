import { DoubleSide, Ray, Vector3, type BufferGeometry, type Mesh } from 'three';
import type { MeshBVH } from 'three-mesh-bvh';

/**
 * Wall thickness at every vertex, by casting inward.
 *
 * From each vertex, step just inside the surface and cast along the inward normal; the
 * first thing hit is the far wall, and the distance is the thickness there. The BVH
 * already built for picking makes this cheap enough to run on a whole part in tens of
 * milliseconds. Vertices whose ray escapes — a degenerate normal at a seam — read as
 * infinitely thick rather than flagging noise.
 */
export function computeVertexThickness(mesh: Mesh): Float32Array {
  const geometry = mesh.geometry as BufferGeometry & { boundsTree?: MeshBVH };
  const bvh = geometry.boundsTree;
  const positions = geometry.getAttribute('position');
  const normals = geometry.getAttribute('normal');
  const out = new Float32Array(positions.count).fill(Number.MAX_VALUE);
  if (!bvh) return out;

  const ray = new Ray();
  const origin = new Vector3();
  const direction = new Vector3();
  const EPSILON = 1e-3;
  for (let i = 0; i < positions.count; i++) {
    direction.set(-normals.getX(i), -normals.getY(i), -normals.getZ(i));
    if (direction.lengthSq() < 0.5) continue;
    direction.normalize();
    origin.set(positions.getX(i), positions.getY(i), positions.getZ(i))
      .addScaledVector(direction, EPSILON);
    ray.set(origin, direction);
    const hit = bvh.raycastFirst(ray, DoubleSide);
    if (hit) out[i] = hit.distance + EPSILON;
  }
  return out;
}
