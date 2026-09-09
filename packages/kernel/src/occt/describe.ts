import type { OpenCascadeInstance, TopoDS_Shape } from 'replicad-opencascadejs';
import type { Bounds, EntityFingerprint, ShapeDescription, Vec3 } from '@cardstock/types';
import { shapeIndexer, subShapes } from './topology.js';

/**
 * Fingerprint every sub-shape, so topological references can be re-identified after a
 * rebuild. See docs/toponaming.md for why this exists and what each field is for.
 */

/**
 * Enum members come back as emscripten objects, not numbers, so the name is recovered by
 * matching against the enum table rather than indexing it.
 */
function enumName(table: Record<string, unknown>, value: unknown, prefix: string): string {
  for (const [name, member] of Object.entries(table)) {
    if (member === value) return name.replace(prefix, '').toLowerCase();
    const a = (member as { value?: number })?.value;
    const b = (value as { value?: number })?.value;
    if (a !== undefined && a === b) return name.replace(prefix, '').toLowerCase();
  }
  return 'unknown';
}

const surfaceTypeName = (oc: OpenCascadeInstance, value: unknown): string =>
  enumName(oc.GeomAbs_SurfaceType as unknown as Record<string, unknown>, value, 'GeomAbs_');

const curveTypeName = (oc: OpenCascadeInstance, value: unknown): string =>
  enumName(oc.GeomAbs_CurveType as unknown as Record<string, unknown>, value, 'GeomAbs_');

const normalise = (p: Vec3, bounds: Bounds): Vec3 => {
  const span = (lo: number, hi: number) => (hi - lo < 1e-9 ? 1 : hi - lo);
  return {
    x: (p.x - bounds.min.x) / span(bounds.min.x, bounds.max.x),
    y: (p.y - bounds.min.y) / span(bounds.min.y, bounds.max.y),
    z: (p.z - bounds.min.z) / span(bounds.min.z, bounds.max.z),
  };
};

export function describeShape(oc: OpenCascadeInstance, shape: TopoDS_Shape): ShapeDescription {
  const faceShapes = subShapes(oc, shape, 'TopAbs_FACE');
  const edgeShapes = subShapes(oc, shape, 'TopAbs_EDGE');
  const vertexShapes = subShapes(oc, shape, 'TopAbs_VERTEX');

  // Bounds first: every coordinate is expressed relative to them.
  const box = new oc.Bnd_Box();
  oc.BRepBndLib.Add(shape, box, true);
  box.SetGap(0);
  const low = box.CornerMin();
  const high = box.CornerMax();
  const bounds: Bounds = {
    min: { x: low.X(), y: low.Y(), z: low.Z() },
    max: { x: high.X(), y: high.Y(), z: high.Z() },
  };
  box.delete();

  // Edge -> adjacent faces. TopExp's MapShapesAndAncestors is not bound in this build
  // (ADR-0001), so the adjacency map is built by hand.
  const edgeNeighbours = new Map<number, string[]>();
  const faceTypeByIndex: string[] = [];
  // Bucketed rather than a linear scan per edge: this loop runs once per edge per face,
  // so a linear findIndex made adjacency the single most expensive part of describing a
  // large shape.
  const edgeIndexOf = shapeIndexer(oc, edgeShapes);

  faceShapes.forEach((faceShape, faceIndex) => {
    const surface = new oc.BRepAdaptor_Surface(oc.TopoDS.Face(faceShape), true);
    const type = surfaceTypeName(oc, surface.GetType());
    faceTypeByIndex[faceIndex] = type;
    for (const edge of subShapes(oc, faceShape, 'TopAbs_EDGE')) {
      const edgeIndex = edgeIndexOf(edge);
      if (edgeIndex < 0) continue;
      const list = edgeNeighbours.get(edgeIndex);
      if (list) list.push(type);
      else edgeNeighbours.set(edgeIndex, [type]);
    }
  });

  // --- faces
  let totalArea = 0;
  const faceRaw = faceShapes.map((faceShape) => {
    const props = new oc.GProp_GProps();
    oc.BRepGProp.SurfaceProperties(faceShape, props, false, false);
    const area = props.Mass();
    const centre = props.CentreOfMass();
    const centroid = { x: centre.X(), y: centre.Y(), z: centre.Z() };
    props.delete();
    totalArea += area;

    const face = oc.TopoDS.Face(faceShape);
    const surface = new oc.BRepAdaptor_Surface(face, true);

    // Normal at the middle of the parameter range.
    //
    // BRepGProp_Face.Normal ALREADY accounts for face orientation and returns the
    // outward normal — unlike Poly_Triangulation.Normal in the tessellator, which does
    // not and must be flipped for REVERSED faces. Applying the flip here as well
    // double-flips exactly the reversed half, collapsing opposite faces of a box onto
    // identical fingerprints. Two OCCT APIs, opposite conventions.
    let direction: Vec3 | null = null;
    try {
      const gprop = new oc.BRepGProp_Face(face);
      const range = gprop.Bounds(0, 0, 0, 0);
      const point = new oc.gp_Pnt(0, 0, 0);
      const normal = new oc.gp_Vec(0, 0, 0);
      gprop.Normal((range.U1 + range.U2) / 2, (range.V1 + range.V2) / 2, point, normal);
      const magnitude = normal.Magnitude();
      if (magnitude > 1e-9) {
        direction = {
          x: normal.X() / magnitude,
          y: normal.Y() / magnitude,
          z: normal.Z() / magnitude,
        };
      }
    } catch { direction = null; }

    return { area, centroid, direction, type: surfaceTypeName(oc, surface.GetType()) };
  });

  const faces: EntityFingerprint[] = faceRaw.map((f, index) => ({
    kind: 'face',
    index,
    geometryType: f.type,
    centroid: f.centroid,
    centroidNormalised: normalise(f.centroid, bounds),
    direction: f.direction,
    measure: f.area,
    measureRatio: totalArea > 0 ? f.area / totalArea : 0,
    neighbourTypes: [],
  }));

  // --- edges
  let totalLength = 0;
  const edgeRaw = edgeShapes.map((edgeShape) => {
    const props = new oc.GProp_GProps();
    oc.BRepGProp.LinearProperties(edgeShape, props, false, false);
    const length = props.Mass();
    const centre = props.CentreOfMass();
    const centroid = { x: centre.X(), y: centre.Y(), z: centre.Z() };
    props.delete();
    totalLength += length;

    const curve = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edgeShape));
    const type = curveTypeName(oc, curve.GetType());
    let direction: Vec3 | null = null;
    try {
      const mid = (curve.FirstParameter() + curve.LastParameter()) / 2;
      const point = new oc.gp_Pnt(0, 0, 0);
      const tangent = new oc.gp_Vec(0, 0, 0);
      curve.D1(mid, point, tangent);
      const magnitude = tangent.Magnitude();
      if (magnitude > 1e-9) {
        direction = { x: tangent.X() / magnitude, y: tangent.Y() / magnitude, z: tangent.Z() / magnitude };
      }
    } catch { direction = null; }

    return { length, centroid, direction, type };
  });

  const edges: EntityFingerprint[] = edgeRaw.map((e, index) => ({
    kind: 'edge',
    index,
    geometryType: e.type,
    centroid: e.centroid,
    centroidNormalised: normalise(e.centroid, bounds),
    direction: e.direction,
    measure: e.length,
    measureRatio: totalLength > 0 ? e.length / totalLength : 0,
    neighbourTypes: [...(edgeNeighbours.get(index) ?? [])].sort(),
  }));

  // --- vertices
  const vertices: EntityFingerprint[] = vertexShapes.map((vertexShape, index) => {
    const p = oc.BRep_Tool.Pnt(oc.TopoDS.Vertex(vertexShape));
    const centroid = { x: p.X(), y: p.Y(), z: p.Z() };
    return {
      kind: 'vertex' as const,
      index,
      geometryType: 'point',
      centroid,
      centroidNormalised: normalise(centroid, bounds),
      direction: null,
      measure: 0,
      measureRatio: 0,
      neighbourTypes: [],
    };
  });

  return { faces, edges, vertices, bounds };
}
