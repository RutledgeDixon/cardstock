import type { Vector2} from 'three';
import { Raycaster, Vector3, type Camera } from 'three';
import type { BodyId, EntityKind, EntityRef } from '@cardstock/types';
import type { BodyView } from '../scene/body-view.js';

export interface PickResult {
  readonly ref: EntityRef;
  /** World-space point under the cursor — used to set the orbit pivot. */
  readonly point: Vector3;
  /** Surface normal, faces only. Used by "look at this face". */
  readonly normal: Vector3 | null;
}

/** Squared 2-D distance from p to segment ab. */
function distSqPointSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const cx = ax + t * dx - px, cy = ay + t * dy - py;
  return cx * cx + cy * cy;
}

/**
 * Resolves a cursor position to a topological entity.
 *
 * Faces use the BVH raycast. Edges and vertices cannot — a ray essentially never hits a
 * one-pixel line — so they are picked by screen-space proximity within a pixel radius,
 * which is also how they behave in every CAD package: you point *near* an edge, not at it.
 *
 * Occlusion is then checked only for the best candidate rather than all of them, since
 * each check costs a raycast.
 */
export class Picker {
  #raycaster = new Raycaster();
  #projected = new Vector3();

  constructor(private readonly bodies: () => Iterable<BodyView>) {
    this.#raycaster.firstHitOnly = true;
  }

  /** @param ndc cursor in normalized device coords, -1..1. */
  pick(
    ndc: Vector2,
    camera: Camera,
    filter: EntityKind,
    viewport: { width: number; height: number },
    pixelRadius = 10,
  ): PickResult | null {
    if (filter === 'face' || filter === 'body') return this.#pickSurface(ndc, camera, filter);
    return this.#pickWireframe(ndc, camera, filter, viewport, pixelRadius);
  }

  #pickSurface(ndc: Vector2, camera: Camera, filter: 'face' | 'body'): PickResult | null {
    this.#raycaster.setFromCamera(ndc, camera);
    let best: PickResult | null = null;
    let bestDist = Infinity;

    for (const body of this.bodies()) {
      const hit = this.#raycaster.intersectObject(body.solid, false)[0];
      if (!hit || hit.distance >= bestDist) continue;

      // See BodyView: with indirect BVH, faceIndex is already in our triangle order.
      const faceId = body.data.triangleFaceId[hit.faceIndex ?? -1];
      if (faceId === undefined) continue;

      bestDist = hit.distance;
      best = {
        ref: {
          bodyId: body.bodyId,
          kind: filter,
          index: filter === 'body' ? 0 : faceId,
        },
        point: hit.point.clone(),
        normal: hit.face
          ? hit.face.normal.clone().transformDirection(body.solid.matrixWorld)
          : null,
      };
    }
    return best;
  }

  #pickWireframe(
    ndc: Vector2,
    camera: Camera,
    filter: 'edge' | 'vertex',
    viewport: { width: number; height: number },
    pixelRadius: number,
  ): PickResult | null {
    // Work in pixels so the tolerance means the same thing at every zoom level.
    const toPx = (v: Vector3) => ({
      x: ((v.x + 1) / 2) * viewport.width,
      y: ((1 - v.y) / 2) * viewport.height,
    });
    const cursor = toPx(new Vector3(ndc.x, ndc.y, 0));
    const radiusSq = pixelRadius * pixelRadius;

    type Candidate = { bodyId: BodyId; index: number; distSq: number; point: Vector3 };
    const candidates: Candidate[] = [];

    for (const body of this.bodies()) {
      if (filter === 'vertex') {
        const p = body.data.vertexPositions;
        for (let i = 0; i < body.data.vertexCount; i++) {
          const world = new Vector3(p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!);
          const s = toPx(this.#projected.copy(world).project(camera));
          const d = (s.x - cursor.x) ** 2 + (s.y - cursor.y) ** 2;
          if (d <= radiusSq) candidates.push({ bodyId: body.bodyId, index: i, distSq: d, point: world });
        }
      } else {
        const p = body.data.edgePositions;
        const ids = body.data.edgeSegmentId;
        for (let s = 0; s < ids.length; s++) {
          const a = new Vector3(p[s * 6]!, p[s * 6 + 1]!, p[s * 6 + 2]!);
          const b = new Vector3(p[s * 6 + 3]!, p[s * 6 + 4]!, p[s * 6 + 5]!);
          const pa = toPx(this.#projected.copy(a).project(camera));
          const pb = toPx(this.#projected.copy(b).project(camera));
          const d = distSqPointSegment(cursor.x, cursor.y, pa.x, pa.y, pb.x, pb.y);
          if (d <= radiusSq) {
            candidates.push({
              bodyId: body.bodyId,
              index: ids[s]!,
              distSq: d,
              point: a.clone().add(b).multiplyScalar(0.5),
            });
          }
        }
      }
    }

    if (candidates.length === 0) return null;
    candidates.sort((x, y) => x.distSq - y.distSq);

    // Occlusion costs a raycast each, so only test the nearest few.
    for (const c of candidates.slice(0, 8)) {
      if (!this.#isOccluded(c.point, camera)) {
        return { ref: { bodyId: c.bodyId, kind: filter, index: c.index }, point: c.point, normal: null };
      }
    }
    return null;
  }

  /** Is `point` hidden behind solid geometry from the camera's position? */
  #isOccluded(point: Vector3, camera: Camera): boolean {
    const origin = camera.position;
    const dir = point.clone().sub(origin);
    const distance = dir.length();
    if (distance < 1e-9) return false;
    dir.divideScalar(distance);
    this.#raycaster.set(origin, dir);
    for (const body of this.bodies()) {
      const hit = this.#raycaster.intersectObject(body.solid, false)[0];
      // Tolerance: an edge lies exactly ON the surface, so it always "hits" its own faces.
      if (hit && hit.distance < distance - 0.05) return true;
    }
    return false;
  }
}
