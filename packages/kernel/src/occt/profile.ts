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

/** The sketch plane and its 2D-to-3D mapping, shared by every profile consumer. */
function placementOf(oc: OpenCascadeInstance, profile: ProfileSpec) {
  const { origin, normal, xAxis } = profile.placement;
  const axis = new oc.gp_Ax3(
    new oc.gp_Pnt(origin.x, origin.y, origin.z),
    new oc.gp_Dir(normal.x, normal.y, normal.z),
    new oc.gp_Dir(xAxis.x, xAxis.y, xAxis.z),
  );
  return {
    plane: new oc.gp_Pln(axis),
    /** Sketch (u, v) to a 3D point on the plane. */
    to3d: (p: Vec2) => {
      const xDir = axis.XDirection();
      const yDir = axis.YDirection();
      return new oc.gp_Pnt(
        origin.x + xDir.X() * p.x + yDir.X() * p.y,
        origin.y + xDir.Y() * p.x + yDir.Y() * p.y,
        origin.z + xDir.Z() * p.x + yDir.Z() * p.y,
      );
    },
  };
}

/**
 * Build a wire from a profile, closed or not.
 *
 * A sweep path is a sketch that was never meant to close — an L-bend, an arc — so it
 * cannot go through makeFace. Everything else about it is the same sketch, mapped onto
 * the same plane, which is why this shares placement and segment handling rather than
 * being a second way to draw.
 */
export function makePath(oc: OpenCascadeInstance, profile: ProfileSpec): TopoDS_Shape {
  const loop = profile.loops[0];
  if (!loop || loop.segments.length === 0) {
    throw new KernelError('a path needs at least one segment', 'makePath');
  }
  const { plane, to3d } = placementOf(oc, profile);
  return makeWire(oc, loop, plane, to3d, 'makePath');
}

export function makeFace(oc: OpenCascadeInstance, profile: ProfileSpec): TopoDS_Shape {
  if (profile.loops.length === 0) {
    throw new KernelError('a face needs at least one closed loop', 'makeFace');
  }

  const { plane, to3d } = placementOf(oc, profile);
  const regions = [profile.loops, ...(profile.regions ?? [])];
  const faces = regions.map((loops) => {
    const wires = loops.map((loop) => makeWire(oc, loop, plane, to3d, 'makeFace'));
    const builder = new oc.BRepBuilderAPI_MakeFace(wires[0]!, false);
    // Later loops are holes. They must run opposite to the outer boundary, or OCCT adds
    // them as separate regions instead of subtracting them.
    // Reversed() hands back a TopoDS_Shape; embind needs a real TopoDS_Wire, and a
    // TypeScript cast does nothing at runtime.
    for (const wire of wires.slice(1)) builder.Add(oc.TopoDS.Wire(wire.Reversed()));
    if (!builder.IsDone()) throw new KernelError('could not build a face from the profile', 'makeFace');
    return builder.Shape();
  });
  if (faces.length === 1) return faces[0]!;

  // Several regions: one face each, gathered without fusing. Extruding the compound
  // gives one solid per region.
  const builder = new oc.TopoDS_Builder();
  const compound = new oc.TopoDS_Compound();
  builder.MakeCompound(compound);
  for (const face of faces) builder.Add(compound, face);
  return compound;
}

function makeWire(
  oc: OpenCascadeInstance,
  loop: ProfileLoopSpec,
  plane: gp_Pln,
  to3d: (p: Vec2) => gp_Pnt,
  op: string,
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

  if (added === 0) throw new KernelError('the profile loop produced no edges', op);
  if (!wire.IsDone()) throw new KernelError('the profile loop does not form a connected wire', op);
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
