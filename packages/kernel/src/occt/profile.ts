import type {
  OpenCascadeInstance, TopoDS_Shape, TopoDS_Wire, gp_Pln, gp_Pnt,
} from 'replicad-opencascadejs';
import type { ProfileLoopSpec, ProfileSpec, Vec2 } from '@cardstock/types';
import { KernelError } from '@cardstock/types';

/**
 * Build a planar face from a closed 2D profile.
 *
 * Sketch coordinates are mapped into 3D through the plane's placement, so the sketcher
 * never has to think in world space and the same profile can sit on any face.
 */

export function makeFace(oc: OpenCascadeInstance, profile: ProfileSpec): TopoDS_Shape {
  if (profile.loops.length === 0) {
    throw new KernelError('a face needs at least one closed loop', 'makeFace');
  }

  const { origin, normal, xAxis } = profile.placement;
  const axis = new oc.gp_Ax3(
    new oc.gp_Pnt(origin.x, origin.y, origin.z),
    new oc.gp_Dir(normal.x, normal.y, normal.z),
    new oc.gp_Dir(xAxis.x, xAxis.y, xAxis.z),
  );
  const plane = new oc.gp_Pln(axis);

  /** Sketch (u, v) to a 3D point on the plane. */
  const to3d = (p: Vec2) => {
    const xDir = axis.XDirection();
    const yDir = axis.YDirection();
    return new oc.gp_Pnt(
      origin.x + xDir.X() * p.x + yDir.X() * p.y,
      origin.y + xDir.Y() * p.x + yDir.Y() * p.y,
      origin.z + xDir.Z() * p.x + yDir.Z() * p.y,
    );
  };

  const wires = profile.loops.map((loop) => makeWire(oc, loop, plane, to3d));

  const builder = new oc.BRepBuilderAPI_MakeFace(wires[0]!, false);
  // Later loops are holes. They must run opposite to the outer boundary, or OCCT adds
  // them as separate regions instead of subtracting them.
  // Reversed() hands back a TopoDS_Shape; embind needs a real TopoDS_Wire, and a
  // TypeScript cast does nothing at runtime.
  for (const wire of wires.slice(1)) builder.Add(oc.TopoDS.Wire(wire.Reversed()));

  if (!builder.IsDone()) throw new KernelError('could not build a face from the profile', 'makeFace');
  return builder.Shape();
}

function makeWire(
  oc: OpenCascadeInstance,
  loop: ProfileLoopSpec,
  plane: gp_Pln,
  to3d: (p: Vec2) => gp_Pnt,
): TopoDS_Wire {
  const wire = new oc.BRepBuilderAPI_MakeWire();
  let added = 0;

  for (const segment of loop.segments) {
    if (segment.kind === 'line') {
      const edge = new oc.BRepBuilderAPI_MakeEdge(to3d(segment.from), to3d(segment.to));
      if (edge.IsDone()) { wire.Add(edge.Edge()); added++; }
      continue;
    }

    if (segment.kind === 'circle') {
      // A circle sits on the sketch plane, centred on its own point.
      const centre = to3d(segment.centre);
      const axis = new oc.gp_Ax2(centre, plane.Axis().Direction());
      const circle = new oc.gp_Circ(axis, segment.radius);
      const edge = new oc.BRepBuilderAPI_MakeEdge(circle);
      if (edge.IsDone()) { wire.Add(edge.Edge()); added++; }
      continue;
    }

    // An arc, built through three points so the direction follows the sketch rather
    // than an angle convention that may not survive the round trip.
    const mid = midpointOf(segment);
    const arc = new oc.GC_MakeArcOfCircle(to3d(segment.from), to3d(mid), to3d(segment.to));
    if (arc.IsDone()) {
      const edge = new oc.BRepBuilderAPI_MakeEdge(arc.Value());
      if (edge.IsDone()) { wire.Add(edge.Edge()); added++; }
    }
  }

  if (added === 0) throw new KernelError('the profile loop produced no edges', 'makeFace');
  if (!wire.IsDone()) throw new KernelError('the profile loop does not form a closed wire', 'makeFace');
  return wire.Wire();
}

/** A point on the arc between its ends, for three-point construction. */
function midpointOf(segment: Extract<ProfileSpec['loops'][number]['segments'][number], { kind: 'arc' }>): Vec2 {
  let sweep = segment.endAngle - segment.startAngle;
  // Normalise into (0, 2pi] so the midpoint lands on the drawn side of the circle.
  while (sweep <= 0) sweep += Math.PI * 2;
  const mid = segment.startAngle + sweep / 2;
  return {
    x: segment.centre.x + segment.radius * Math.cos(mid),
    y: segment.centre.y + segment.radius * Math.sin(mid),
  };
}
