import OC from 'replicad-opencascadejs';
import { tessellate, subShapes } from './tessellate.mjs';

const oc = await OC();

function bracket() {
  // A shape with planar AND curved faces, so face tagging is actually exercised.
  const base = new oc.BRepPrimAPI_MakeBox(40, 30, 20).Shape();
  const axis = new oc.gp_Ax2(new oc.gp_Pnt(20, 15, -5), new oc.gp_Dir(0, 0, 1));
  const hole = new oc.BRepPrimAPI_MakeCylinder(axis, 6, 30).Shape();
  const cut = new oc.BRepAlgoAPI_Cut(base, hole);
  cut.Build(new oc.Message_ProgressRange());
  const fil = new oc.BRepFilletAPI_MakeFillet(cut.Shape(), oc.ChFi3d_FilletShape.ChFi3d_Rational);
  const edges = subShapes(oc, cut.Shape(), 'TopAbs_EDGE');
  // fillet the four vertical corner edges
  let added = 0;
  for (const e of edges) {
    const c = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(e));
    const p0 = c.Value(c.FirstParameter()), p1 = c.Value(c.LastParameter());
    const isVertical = Math.abs(p0.X() - p1.X()) < 1e-6 && Math.abs(p0.Y() - p1.Y()) < 1e-6;
    const isCorner = isVertical && (Math.abs(p0.X()) < 1e-6 || Math.abs(p0.X() - 40) < 1e-6);
    if (isCorner) { fil.Add(3.0, oc.TopoDS.Edge(e)); added++; }
  }
  fil.Build(new oc.Message_ProgressRange());
  console.log(`  model: box - Ø12 hole, ${added} corner edges filleted r3`);
  return fil.Shape();
}

const shape = bracket();

console.log('\n=== tessellation quality sweep');
for (const ld of [0.5, 0.1, 0.02]) {
  const m = tessellate(oc, shape, { linearDeflection: ld });
  console.log(
    `  deflection ${String(ld).padEnd(5)} ${String(m.stats.triangles).padStart(6)} tris  ` +
      `${String(m.stats.vertices).padStart(6)} verts  ${m.stats.meshMs} ms  faces=${m.faceCount}`,
  );
}

const mesh = tessellate(oc, shape, { linearDeflection: 0.05 });

console.log('\n=== integrity checks');
const checks = [];
const push = (name, pass, detail) => { checks.push({ name, pass, detail }); };

push('indices in range', mesh.indices.every((i) => i < mesh.positions.length / 3),
  `max idx ${Math.max(...mesh.indices)} vs ${mesh.positions.length / 3} verts`);
push('one face id per triangle', mesh.triangleFaceId.length === mesh.indices.length / 3,
  `${mesh.triangleFaceId.length} ids / ${mesh.indices.length / 3} tris`);
push('every face produced geometry', new Set(mesh.triangleFaceId).size === mesh.faceCount,
  `${new Set(mesh.triangleFaceId).size} tagged of ${mesh.faceCount} faces`);
push('no degenerate normals', (() => {
  for (let i = 0; i < mesh.normals.length; i += 3) {
    const L = Math.hypot(mesh.normals[i], mesh.normals[i+1], mesh.normals[i+2]);
    if (L < 0.9 || L > 1.1) return false;
  } return true;
})(), 'all unit length');
push('no skipped faces', mesh.stats.skipped === 0, `${mesh.stats.skipped} skipped`);

// Outward winding: signed volume from the triangle soup must match OCCT's volume.
let signed = 0;
for (let t = 0; t < mesh.indices.length; t += 3) {
  const g = (k) => { const i = mesh.indices[t + k] * 3; return [mesh.positions[i], mesh.positions[i+1], mesh.positions[i+2]]; };
  const [a, b, c] = [g(0), g(1), g(2)];
  signed += (a[0]*(b[1]*c[2]-b[2]*c[1]) - a[1]*(b[0]*c[2]-b[2]*c[0]) + a[2]*(b[0]*c[1]-b[1]*c[0])) / 6;
}
const p = new oc.GProp_GProps();
oc.BRepGProp.VolumeProperties(shape, p, false, false, false);
const exact = p.Mass();
push('winding is outward (mesh volume ≈ B-rep volume)',
  signed > 0 && Math.abs(signed - exact) / exact < 0.01,
  `mesh ${signed.toFixed(1)} vs brep ${exact.toFixed(1)} (${((signed-exact)/exact*100).toFixed(2)}%)`);

for (const c of checks) console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name.padEnd(46)} ${c.detail}`);
console.log(`\n  edges: ${mesh.edges.length / 6} line segments`);
const failed = checks.filter((c) => !c.pass).length;
console.log(failed ? `\n  ${failed} CHECK(S) FAILED` : '\n  All integrity checks passed.');

// Emit for the browser half of the spike.
const { writeFileSync } = await import('node:fs');
writeFileSync('tools/spikes/out-mesh.json', JSON.stringify({
  positions: [...mesh.positions], normals: [...mesh.normals],
  indices: [...mesh.indices], triangleFaceId: [...mesh.triangleFaceId],
  edges: [...mesh.edges], faceCount: mesh.faceCount,
}));
console.log('  wrote tools/spikes/out-mesh.json for the browser picking test');
process.exit(failed ? 1 : 0);
