import type { OpenCascadeInstance, TopoDS_Shape } from 'replicad-opencascadejs';
import type { FaceOutline, OutlineEdge, Vec3 } from '@cardstock/types';
import { KernelError } from '@cardstock/types';
import { subShapes } from './topology.js';

/**
 * The edges bounding one face, as a sketch on that face can use them.
 *
 * Straight edges are two ends; circular ones a centre, radius and ends. The sketch
 * projects these into its own plane and keeps them as fixed reference geometry, so a
 * point can be made coincident with a corner of the face, or a line parallel to one of
 * its edges, and follow it when the body changes.
 */
export function faceOutline(oc: OpenCascadeInstance, shape: TopoDS_Shape, faceIndex: number): FaceOutline {
  const faces = subShapes(oc, shape, 'TopAbs_FACE');
  const faceShape = faces[faceIndex];
  if (!faceShape) throw new KernelError(`no face ${faceIndex} on this shape`, 'faceOutline');

  const edges: OutlineEdge[] = [];
  for (const edgeShape of subShapes(oc, faceShape, 'TopAbs_EDGE')) {
    const edge = oc.TopoDS.Edge(edgeShape);
    const curve = new oc.BRepAdaptor_Curve(edge);
    const at = (u: number): Vec3 => { const p = curve.Value(u); return { x: p.X(), y: p.Y(), z: p.Z() }; };
    const from = at(curve.FirstParameter());
    const to = at(curve.LastParameter());
    const type = curve.GetType();
    if (type === oc.GeomAbs_CurveType.GeomAbs_Line) {
      edges.push({ kind: 'line', from, to });
    } else if (type === oc.GeomAbs_CurveType.GeomAbs_Circle) {
      const circle = curve.Circle();
      const location = circle.Location();
      const closed = Math.hypot(from.x - to.x, from.y - to.y, from.z - to.z) < 1e-7;
      edges.push({
        kind: 'circle', centre: { x: location.X(), y: location.Y(), z: location.Z() },
        radius: circle.Radius(), from, to, closed,
      });
    } else {
      edges.push({ kind: 'other', from, to });
    }
  }
  return { edges };
}
