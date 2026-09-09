/**
 * Spike B — tessellation with topology tags.
 *
 * The whole right-click-a-face interaction depends on the renderer knowing which
 * OCCT face each triangle came from. This produces a single merged buffer plus a
 * per-triangle face id, which is what lets a BVH raycast hit resolve straight back
 * to a topological entity.
 *
 * Seed of @cardstock/kernel/src/tessellate.
 */

/** Unique sub-shapes in deterministic traversal order (no TopTools in this build). */
export function subShapes(oc, shape, kind) {
  const out = [];
  const ex = new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum[kind], oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  for (; ex.More(); ex.Next()) {
    const c = ex.Current();
    if (!out.some((s) => s.IsSame(c))) out.push(c);
  }
  ex.delete();
  return out;
}

/**
 * @returns {{positions:Float32Array, normals:Float32Array, indices:Uint32Array,
 *            triangleFaceId:Uint32Array, faceCount:number, edges:Float32Array,
 *            stats:object}}
 */
export function tessellate(oc, shape, { linearDeflection = 0.1, angularDeflection = 0.35 } = {}) {
  const t0 = Date.now();
  new oc.BRepMesh_IncrementalMesh(shape, linearDeflection, false, angularDeflection, false);
  const tMesh = Date.now() - t0;

  const faces = subShapes(oc, shape, 'TopAbs_FACE');
  const pos = [], nrm = [], idx = [], triFaceId = [];
  let vertexBase = 0;
  let skipped = 0;

  faces.forEach((faceShape, faceId) => {
    const face = oc.TopoDS.Face(faceShape);
    const loc = new oc.TopLoc_Location();
    const tri = oc.BRep_Tool.Triangulation(face, loc, 0);
    if (!tri || !tri.NbTriangles || tri.NbTriangles() === 0) { skipped++; loc.delete(); return; }

    // OCCT gives no normals by default; ask it to derive them from the surface.
    if (!tri.HasNormals()) tri.ComputeNormals();

    const trsf = loc.Transformation();
    const identity = loc.IsIdentity();
    // A REVERSED face means the triangle winding points into the solid.
    const reversed = face.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED;

    const nNodes = tri.NbNodes();
    for (let i = 1; i <= nNodes; i++) {
      const p = identity ? tri.Node(i) : tri.Node(i).Transformed(trsf);
      pos.push(p.X(), p.Y(), p.Z());
      let nx = 0, ny = 0, nz = 1;
      if (tri.HasNormals()) {
        const d = identity ? tri.Normal(i) : tri.Normal(i).Transformed(trsf);
        nx = d.X(); ny = d.Y(); nz = d.Z();
      }
      if (reversed) { nx = -nx; ny = -ny; nz = -nz; }
      nrm.push(nx, ny, nz);
    }

    const nTris = tri.NbTriangles();
    for (let i = 1; i <= nTris; i++) {
      const t = tri.Triangle(i);
      const a = t.Value(1) - 1 + vertexBase;
      const b = t.Value(2) - 1 + vertexBase;
      const c = t.Value(3) - 1 + vertexBase;
      if (reversed) idx.push(a, c, b); else idx.push(a, b, c);
      triFaceId.push(faceId);
    }

    vertexBase += nNodes;
    loc.delete();
  });

  // Edge polylines for the wireframe overlay — CAD reads as edges, not triangles.
  const edgePts = [];
  for (const e of subShapes(oc, shape, 'TopAbs_EDGE')) {
    const edge = oc.TopoDS.Edge(e);
    const loc = new oc.TopLoc_Location();
    const adaptor = new oc.BRepAdaptor_Curve(edge);
    const first = adaptor.FirstParameter(), last = adaptor.LastParameter();
    const segs = 32;
    let prev = null;
    for (let s = 0; s <= segs; s++) {
      const u = first + ((last - first) * s) / segs;
      const p = adaptor.Value(u);
      if (prev) edgePts.push(prev[0], prev[1], prev[2], p.X(), p.Y(), p.Z());
      prev = [p.X(), p.Y(), p.Z()];
    }
    loc.delete();
  }

  return {
    positions: new Float32Array(pos),
    normals: new Float32Array(nrm),
    indices: new Uint32Array(idx),
    triangleFaceId: new Uint32Array(triFaceId),
    faceCount: faces.length,
    edges: new Float32Array(edgePts),
    stats: { meshMs: tMesh, vertices: pos.length / 3, triangles: idx.length / 3, skipped },
  };
}
