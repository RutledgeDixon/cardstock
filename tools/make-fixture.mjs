/**
 * Generates a TessellatedBody fixture from OCCT for Phase 1 viewer development.
 *
 * Phase 3 replaces this with the live kernel; until then the viewer is developed against
 * static, checked-in data so it can be worked on without the kernel existing yet.
 *
 * Run: node tools/make-fixture.mjs
 */
import OC from 'replicad-opencascadejs';
import { writeFileSync } from 'node:fs';

const oc = await OC();

/** Unique sub-shapes in deterministic traversal order (no TopTools in this build). */
function subShapes(shape, kind) {
  const out = [];
  const ex = new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum[kind], oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  for (; ex.More(); ex.Next()) {
    const c = ex.Current();
    if (!out.some((s) => s.IsSame(c))) out.push(c);
  }
  ex.delete();
  return out;
}

function buildBracket() {
  const base = new oc.BRepPrimAPI_MakeBox(60, 40, 18).Shape();

  // Two mounting holes.
  let solid = base;
  for (const [x, y] of [[15, 20], [45, 20]]) {
    const axis = new oc.gp_Ax2(new oc.gp_Pnt(x, y, -5), new oc.gp_Dir(0, 0, 1));
    const drill = new oc.BRepPrimAPI_MakeCylinder(axis, 4, 30).Shape();
    const cut = new oc.BRepAlgoAPI_Cut(solid, drill);
    cut.Build(new oc.Message_ProgressRange());
    solid = cut.Shape();
  }

  // A slot through the middle, so there are non-trivial internal faces to pick.
  const slot = new oc.BRepPrimAPI_MakeBox(
    new oc.gp_Pnt(26, -5, 6), 8, 50, 6,
  ).Shape();
  const cutSlot = new oc.BRepAlgoAPI_Cut(solid, slot);
  cutSlot.Build(new oc.Message_ProgressRange());
  solid = cutSlot.Shape();

  // Round the four vertical corners.
  const fil = new oc.BRepFilletAPI_MakeFillet(solid, oc.ChFi3d_FilletShape.ChFi3d_Rational);
  let filleted = 0;
  for (const e of subShapes(solid, 'TopAbs_EDGE')) {
    const c = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(e));
    const p0 = c.Value(c.FirstParameter()), p1 = c.Value(c.LastParameter());
    const vertical = Math.abs(p0.X() - p1.X()) < 1e-6 && Math.abs(p0.Y() - p1.Y()) < 1e-6;
    const atCorner = vertical &&
      (Math.abs(p0.X()) < 1e-6 || Math.abs(p0.X() - 60) < 1e-6) &&
      (Math.abs(p0.Y()) < 1e-6 || Math.abs(p0.Y() - 40) < 1e-6);
    if (atCorner) { fil.Add(5.0, oc.TopoDS.Edge(e)); filleted++; }
  }
  fil.Build(new oc.Message_ProgressRange());
  console.log(`  bracket: 60x40x18, 2 holes, 1 slot, ${filleted} corners filleted r5`);
  return fil.Shape();
}

function tessellate(shape, { linearDeflection = 0.05, angularDeflection = 0.3 } = {}) {
  new oc.BRepMesh_IncrementalMesh(shape, linearDeflection, false, angularDeflection, false);

  const faces = subShapes(shape, 'TopAbs_FACE');
  const pos = [], nrm = [], idx = [], triFaceId = [], vertFaceId = [];
  let base = 0;

  faces.forEach((faceShape, faceId) => {
    const face = oc.TopoDS.Face(faceShape);
    const loc = new oc.TopLoc_Location();
    const tri = oc.BRep_Tool.Triangulation(face, loc, 0);
    if (!tri || !tri.NbTriangles || tri.NbTriangles() === 0) { loc.delete(); return; }
    if (!tri.HasNormals()) tri.ComputeNormals();

    const trsf = loc.Transformation();
    const identity = loc.IsIdentity();
    const reversed = face.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED;

    const n = tri.NbNodes();
    for (let i = 1; i <= n; i++) {
      const p = identity ? tri.Node(i) : tri.Node(i).Transformed(trsf);
      pos.push(p.X(), p.Y(), p.Z());
      let d = tri.Normal(i);
      if (!identity) d = d.Transformed(trsf);
      const s = reversed ? -1 : 1;
      nrm.push(d.X() * s, d.Y() * s, d.Z() * s);
      vertFaceId.push(faceId);
    }
    for (let i = 1; i <= tri.NbTriangles(); i++) {
      const t = tri.Triangle(i);
      const a = t.Value(1) - 1 + base, b = t.Value(2) - 1 + base, c = t.Value(3) - 1 + base;
      if (reversed) idx.push(a, c, b); else idx.push(a, b, c);
      triFaceId.push(faceId);
    }
    base += n;
    loc.delete();
  });

  // Edges, tessellated per edge so each segment carries its OCCT edge index.
  const edgePositions = [], edgeSegmentId = [];
  const edges = subShapes(shape, 'TopAbs_EDGE');
  edges.forEach((e, edgeId) => {
    const adaptor = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(e));
    const first = adaptor.FirstParameter(), last = adaptor.LastParameter();
    // Straight edges need two points; curved ones need enough to look smooth.
    const isLine = adaptor.GetType() === oc.GeomAbs_CurveType.GeomAbs_Line;
    const segs = isLine ? 1 : 48;
    let prev = null;
    for (let s = 0; s <= segs; s++) {
      const p = adaptor.Value(first + ((last - first) * s) / segs);
      const cur = [p.X(), p.Y(), p.Z()];
      if (prev) { edgePositions.push(...prev, ...cur); edgeSegmentId.push(edgeId); }
      prev = cur;
    }
  });

  // Topological vertices.
  const vertexPositions = [];
  const verts = subShapes(shape, 'TopAbs_VERTEX');
  for (const v of verts) {
    const p = oc.BRep_Tool.Pnt(oc.TopoDS.Vertex(v));
    vertexPositions.push(p.X(), p.Y(), p.Z());
  }

  // Bounds straight from the mesh.
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], pos[i + k]);
      max[k] = Math.max(max[k], pos[i + k]);
    }
  }

  return {
    bodyId: 'fixture-bracket',
    positions: pos, normals: nrm, indices: idx,
    triangleFaceId: triFaceId, vertexFaceId: vertFaceId,
    faceCount: faces.length,
    edgePositions, edgeSegmentId, edgeCount: edges.length,
    vertexPositions, vertexCount: verts.length,
    bounds: { min: { x: min[0], y: min[1], z: min[2] }, max: { x: max[0], y: max[1], z: max[2] } },
  };
}

const shape = buildBracket();
const body = tessellate(shape);

const props = new oc.GProp_GProps();
oc.BRepGProp.VolumeProperties(shape, props, false, false, false);

console.log(`  faces ${body.faceCount}  edges ${body.edgeCount}  vertices ${body.vertexCount}`);
console.log(`  triangles ${body.indices.length / 3}  edge segments ${body.edgeSegmentId.length}`);
console.log(`  volume ${props.Mass().toFixed(2)} mm^3`);
console.log(`  bounds ${JSON.stringify(body.bounds)}`);

writeFileSync('fixtures/bracket.json', JSON.stringify(body));
console.log('  wrote fixtures/bracket.json');
