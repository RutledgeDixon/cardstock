import type { FaceOutline, PlanePlacement, Vec2, Vec3 } from '@cardstock/types';
import type { SketchPlane } from './sketch.js';

/**
 * Geometry from outside the sketch, projected into its plane.
 *
 * A sketch on an origin plane sees the origin and the two axes; a sketch on a face sees
 * that face's edges and corners. They arrive as fixed reference entities, keyed so the
 * same corner is the same entity on every rebuild — which is what lets a constraint
 * against it survive the body underneath changing.
 */
export type ExternalItem =
  | { readonly key: string; readonly kind: 'point'; readonly at: Vec2 }
  /** Ends are the keys of point items, so corners shared by two edges are one point. */
  | { readonly key: string; readonly kind: 'line'; readonly p1: string; readonly p2: string }
  | { readonly key: string; readonly kind: 'circle'; readonly centre: Vec2; readonly radius: number };

/** How far the origin axes are drawn, in sketch units. Long enough to reach any part. */
export const AXIS_REACH = 500;

/** 3D to sketch-plane coordinates. The plane's Y is normal × X. */
export function projectToPlane(p: Vec3, placement: PlanePlacement): Vec2 {
  const { origin, normal, xAxis } = placement;
  const yAxis = {
    x: normal.y * xAxis.z - normal.z * xAxis.y,
    y: normal.z * xAxis.x - normal.x * xAxis.z,
    z: normal.x * xAxis.y - normal.y * xAxis.x,
  };
  const d = { x: p.x - origin.x, y: p.y - origin.y, z: p.z - origin.z };
  return {
    x: d.x * xAxis.x + d.y * xAxis.y + d.z * xAxis.z,
    y: d.x * yAxis.x + d.y * yAxis.y + d.z * yAxis.z,
  };
}

/** What an origin-plane sketch can constrain against: the two axes through the origin. */
export function originPlaneExternals(): ExternalItem[] {
  return [
    { key: 'axis:h.a', kind: 'point', at: { x: -AXIS_REACH, y: 0 } },
    { key: 'axis:h.b', kind: 'point', at: { x: AXIS_REACH, y: 0 } },
    { key: 'axis:v.a', kind: 'point', at: { x: 0, y: -AXIS_REACH } },
    { key: 'axis:v.b', kind: 'point', at: { x: 0, y: AXIS_REACH } },
    { key: 'axis:h', kind: 'line', p1: 'axis:h.a', p2: 'axis:h.b' },
    { key: 'axis:v', kind: 'line', p1: 'axis:v.a', p2: 'axis:v.b' },
  ];
}

/**
 * What a face sketch can constrain against: the face's edges, projected.
 *
 * Keyed by index within the outline. Edges are reported in a stable order for a given
 * face, so the key holds as long as the face keeps its edge count; when it does not, the
 * constraints on the vanished edges go with them, loudly, as with any deleted entity.
 */
export function faceExternals(outline: FaceOutline, placement: PlanePlacement): ExternalItem[] {
  const items: ExternalItem[] = [];
  const seen = new Map<string, string>();
  const corner = (p: Vec3, key: string): string => {
    // Corners shared by two edges are one point, matched by position.
    const at = projectToPlane(p, placement);
    const position = `${at.x.toFixed(6)},${at.y.toFixed(6)}`;
    const existing = seen.get(position);
    if (existing) return existing;
    seen.set(position, key);
    items.push({ key, kind: 'point', at });
    return key;
  };
  outline.edges.forEach((edge, i) => {
    if (edge.kind === 'circle' && edge.closed) {
      items.push({ key: `edge:${i}`, kind: 'circle', centre: projectToPlane(edge.centre, placement), radius: edge.radius });
      return;
    }
    const a = corner(edge.from, `corner:${i}a`);
    const b = corner(edge.to, `corner:${i}b`);
    if (edge.kind === 'line') {
      items.push({ key: `edge:${i}`, kind: 'line', p1: a, p2: b });
    } else if (edge.kind === 'circle') {
      // An arc: its centre is worth having, and its ends are already corners.
      items.push({ key: `edge:${i}:centre`, kind: 'point', at: projectToPlane(edge.centre, placement) });
    }
  });
  return items;
}

export function externalsFor(plane: SketchPlane, placement: PlanePlacement, outline: FaceOutline | null): ExternalItem[] {
  return plane.kind === 'origin' ? originPlaneExternals() : outline ? faceExternals(outline, placement) : [];
}
