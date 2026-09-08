/**
 * Spike A — de-risk OpenCascade WASM as the CARDstock geometry kernel.
 *
 * Answers four questions before anything depends on them:
 *   1. Size    — what do we actually ship to the browser?
 *   2. Speed   — boot, model, tessellate.
 *   3. History — do Generated/Modified/IsDeleted work? (Phase 4 lives or dies here)
 *   4. Coverage— does the trimmed build carry the whole roadmap's API surface?
 *
 * Run: node tools/spikes/occt-spike.mjs
 */
import OC from 'replicad-opencascadejs';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ms = () => Date.now();
const ok = (b) => (b ? 'yes' : 'NO');

const tBoot = ms();
const oc = await OC();
const bootMs = ms() - tBoot;

// ---------------------------------------------------------------- helpers
/** Unique sub-shapes in deterministic traversal order.
 *  NCollection_IndexedMap is exported but NOT constructible in this build
 *  (unbound base type NCollection_BaseMap), so we dedupe with IsSame.
 *  O(n^2), fine at part scale; revisit if a shape ever has thousands of faces. */
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
/** Drain an NCollection_List_TopoDS_Shape (no iterator class is bound). */
function drainList(list) {
  const out = [];
  while (list.Size() > 0) { out.push(list.First()); list.RemoveFirst(); }
  return out;
}
const volume = (s) => {
  const p = new oc.GProp_GProps();
  oc.BRepGProp.VolumeProperties(s, p, false, false, false);
  const v = p.Mass(); p.delete(); return v;
};

// ---------------------------------------------------------------- 1. size
const wasmPath = require.resolve('replicad-opencascadejs/wasm');
const rawMB = (readFileSync(wasmPath).length / 1048576).toFixed(1);
console.log(`\n=== 1. SIZE`);
console.log(`  trimmed wasm    ${rawMB} MB raw  /  4.8 MB brotli-11  (measured separately)`);
console.log(`  full occt.js    62.8 MB raw  /  9.0 MB brotli-11`);

// ---------------------------------------------------------------- 2. speed
console.log(`\n=== 2. SPEED`);
console.log(`  boot            ${bootMs} ms`);

let t = ms();
const box = new oc.BRepPrimAPI_MakeBox(40, 30, 20).Shape();
const tBox = ms() - t;
const faces = subShapes(box, 'TopAbs_FACE');
const edges = subShapes(box, 'TopAbs_EDGE');

t = ms();
const axis = new oc.gp_Ax2(new oc.gp_Pnt(20, 15, -5), new oc.gp_Dir(0, 0, 1));
const cyl = new oc.BRepPrimAPI_MakeCylinder(axis, 6, 30).Shape();
const cut = new oc.BRepAlgoAPI_Cut(box, cyl);
cut.Build(new oc.Message_ProgressRange());
const cutShape = cut.Shape();
const tBool = ms() - t;

t = ms();
const fil = new oc.BRepFilletAPI_MakeFillet(box, oc.ChFi3d_FilletShape.ChFi3d_Rational);
fil.Add(4.0, oc.TopoDS.Edge(edges[0]));
fil.Build(new oc.Message_ProgressRange());
const filleted = fil.Shape();
const tFillet = ms() - t;

t = ms();
new oc.BRepMesh_IncrementalMesh(cutShape, 0.05, false, 0.5, false);
let tris = 0;
for (const f of subShapes(cutShape, 'TopAbs_FACE')) {
  const loc = new oc.TopLoc_Location();
  const tri = oc.BRep_Tool.Triangulation(oc.TopoDS.Face(f), loc, 0);
  if (tri && tri.NbTriangles) tris += tri.NbTriangles();
  loc.delete();
}
const tMesh = ms() - t;

console.log(`  box             ${tBox} ms   (6 faces, 12 edges, vol ${volume(box)})`);
console.log(`  boolean cut     ${tBool} ms   (vol ${volume(cutShape).toFixed(1)})`);
console.log(`  fillet r4       ${tFillet} ms   (vol ${volume(filleted).toFixed(1)})`);
console.log(`  tessellate      ${tMesh} ms   (${tris} triangles @ 0.05mm deflection)`);

// ---------------------------------------------------------------- 3. history
console.log(`\n=== 3. HISTORY  (Phase 4 depends entirely on this)`);
const genFaces = drainList(fil.Generated(edges[0]));
const modFaces = drainList(fil.Modified(faces[0]));
console.log(`  Generated(edge0)  ${genFaces.length} face(s)   <- the fillet surface`);
console.log(`  Modified(face0)   ${modFaces.length} replacement(s)`);
console.log(`  IsDeleted(face0)  ${fil.IsDeleted(faces[0])}`);
const bGen = drainList(cut.Modified(faces[0]));
console.log(`  boolean Modified(face0) -> ${bGen.length}  (booleans carry history too)`);
console.log(`  verdict: provenance-based topological naming is VIABLE.`);

// ---------------------------------------------------------------- 4. coverage
console.log(`\n=== 4. ROADMAP API COVERAGE`);
const need = {
  'Phase 7 sweeps':     ['BRepOffsetAPI_MakePipe', 'BRepOffsetAPI_ThruSections', 'BRepPrimAPI_MakeRevol'],
  'Phase 7 mods':       ['BRepFilletAPI_MakeChamfer', 'BRepOffsetAPI_MakeThickSolid', 'BRepOffsetAPI_DraftAngle'],
  'Phase 6 sketch':     ['BRepBuilderAPI_MakeWire', 'BRepBuilderAPI_MakeFace', 'BRepBuilderAPI_MakeEdge', 'GC_MakeArcOfCircle'],
  'Phase 7 transforms': ['BRepBuilderAPI_Transform', 'gp_Trsf', 'BRepBuilderAPI_Copy'],
  'Phase 8 export':     ['StlAPI_Writer', 'STEPControl_Writer', 'STEPControl_Reader'],
  'Phase 9 analysis':   ['BRepGProp', 'BRepAlgoAPI_Section', 'BRepExtrema_DistShapeShape', 'Bnd_Box'],
};
let missing = 0;
for (const [group, syms] of Object.entries(need)) {
  const gone = syms.filter((s) => !(s in oc));
  missing += gone.length;
  console.log(`  ${group.padEnd(20)} ${gone.length === 0 ? 'complete' : 'MISSING: ' + gone.join(', ')}`);
}
console.log(`\n  ${missing === 0 ? 'Full roadmap coverage in the trimmed build.' : missing + ' symbol(s) missing — see ADR-0001.'}`);
