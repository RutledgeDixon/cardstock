import type { OpenCascadeInstance, TopoDS_Shape } from 'replicad-opencascadejs';
import type { BodyId, TessellatedBody, TessellationQuality } from '@cardstock/types';
import { subShapes } from '../occt/topology.js';

/**
 * Turn a B-rep solid into buffers the viewer can draw and pick.
 *
 * The per-triangle and per-vertex face ids are what make right-clicking a face
 * meaningful; see docs/adr/0002 for how they survive the BVH build.
 */
export function tessellate(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  bodyId: BodyId,
  quality: TessellationQuality,
): TessellatedBody {
  new oc.BRepMesh_IncrementalMesh(
    shape, quality.linearDeflection, false, quality.angularDeflection, false,
  );

  const faces = subShapes(oc, shape, 'TopAbs_FACE');
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const triangleFaceId: number[] = [];
  const vertexFaceId: number[] = [];
  let base = 0;

  faces.forEach((faceShape, faceId) => {
    const face = oc.TopoDS.Face(faceShape);
    const location = new oc.TopLoc_Location();
    // Handles are auto-dereferenced in this build: this returns a Poly_Triangulation
    // directly, not a handle, so there is no .IsNull() or .get(). The third argument
    // is required (ADR-0001).
    const triangulation = oc.BRep_Tool.Triangulation(face, location, 0);
    if (!triangulation || triangulation.NbTriangles() === 0) {
      location.delete();
      return;
    }
    if (!triangulation.HasNormals()) triangulation.ComputeNormals();

    const transform = location.Transformation();
    const isIdentity = location.IsIdentity();
    // A REVERSED face means the triangle winding points into the solid: flip both the
    // winding and the normals. Getting this wrong looks fine until something is shaded
    // or exported; the signed-volume check in the tests is what catches it.
    const reversed = face.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED;
    const sign = reversed ? -1 : 1;

    const nodeCount = triangulation.NbNodes();
    for (let i = 1; i <= nodeCount; i++) {
      const node = triangulation.Node(i);
      const point = isIdentity ? node : node.Transformed(transform);
      positions.push(point.X(), point.Y(), point.Z());

      const rawNormal = triangulation.Normal(i);
      const normal = isIdentity ? rawNormal : rawNormal.Transformed(transform);
      normals.push(normal.X() * sign, normal.Y() * sign, normal.Z() * sign);

      vertexFaceId.push(faceId);
    }

    const triangleCount = triangulation.NbTriangles();
    for (let i = 1; i <= triangleCount; i++) {
      const triangle = triangulation.Triangle(i);
      const a = triangle.Value(1) - 1 + base;
      const b = triangle.Value(2) - 1 + base;
      const c = triangle.Value(3) - 1 + base;
      if (reversed) indices.push(a, c, b);
      else indices.push(a, b, c);
      triangleFaceId.push(faceId);
    }

    base += nodeCount;
    location.delete();
  });

  // Edges are tessellated per edge so each segment carries its OCCT edge index. CAD
  // reads as edges, not triangles, so these are drawn as their own line geometry.
  const edgePositions: number[] = [];
  const edgeSegmentId: number[] = [];
  const edges = subShapes(oc, shape, 'TopAbs_EDGE');
  edges.forEach((edgeShape, edgeId) => {
    const curve = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edgeShape));
    const first = curve.FirstParameter();
    const last = curve.LastParameter();
    const isLine = curve.GetType() === oc.GeomAbs_CurveType.GeomAbs_Line;
    const segments = isLine ? 1 : 48;
    let previous: [number, number, number] | null = null;
    for (let s = 0; s <= segments; s++) {
      const p = curve.Value(first + ((last - first) * s) / segments);
      const current: [number, number, number] = [p.X(), p.Y(), p.Z()];
      if (previous) {
        edgePositions.push(...previous, ...current);
        edgeSegmentId.push(edgeId);
      }
      previous = current;
    }
  });

  const vertexPositions: number[] = [];
  const vertices = subShapes(oc, shape, 'TopAbs_VERTEX');
  for (const vertexShape of vertices) {
    const p = oc.BRep_Tool.Pnt(oc.TopoDS.Vertex(vertexShape));
    vertexPositions.push(p.X(), p.Y(), p.Z());
  }

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k]!;
      if (v < min[k]!) min[k] = v;
      if (v > max[k]!) max[k] = v;
    }
  }
  const finite = Number.isFinite(min[0]);

  return {
    bodyId,
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    triangleFaceId: new Uint32Array(triangleFaceId),
    vertexFaceId: new Float32Array(vertexFaceId),
    faceCount: faces.length,
    edgePositions: new Float32Array(edgePositions),
    edgeSegmentId: new Uint32Array(edgeSegmentId),
    edgeCount: edges.length,
    vertexPositions: new Float32Array(vertexPositions),
    vertexCount: vertices.length,
    bounds: finite
      ? { min: { x: min[0]!, y: min[1]!, z: min[2]! }, max: { x: max[0]!, y: max[1]!, z: max[2]! } }
      : { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
  };
}

/** Transferable buffers, so a worker can hand the mesh over without copying. */
export function tessellationTransferables(body: TessellatedBody): ArrayBuffer[] {
  return [
    body.positions.buffer, body.normals.buffer, body.indices.buffer,
    body.triangleFaceId.buffer, body.vertexFaceId.buffer,
    body.edgePositions.buffer, body.edgeSegmentId.buffer, body.vertexPositions.buffer,
  ] as ArrayBuffer[];
}
