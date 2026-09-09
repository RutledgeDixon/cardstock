/**
 * Spike C — 2D constraint solver (PlaneGCS, FreeCAD's own solver, via WASM).
 *
 * Phase 6 is the largest phase in the plan, and all of it rests on this. Four
 * questions, each of which would change the plan if the answer were no:
 *   1. Does it solve a realistic constrained profile?
 *   2. Can sketch dimensions be driven by NAMED parameters and re-solved?
 *      (this is the parametric-propagation promise, at sketch level)
 *   3. Does it report DOF, so we can show under/over-constrained state?
 *   4. Does it identify CONFLICTING constraints by name, so errors are actionable?
 */
import { make_gcs_wrapper, SolveStatus } from '@salusoft89/planegcs';

const STATUS = ['Success', 'Converged', 'Failed', 'SuccessfulSolutionInvalid'];
const t0 = Date.now();
const gcs = await make_gcs_wrapper();
console.log(`\nPlaneGCS boot: ${Date.now() - t0} ms`);

/** A rectangle: 4 shared corner points, 4 lines, driven by named params W and H. */
function rectangle(gcs, { w, h }) {
  gcs.push_primitives_and_params([
    { type: 'param', name: 'W', value: w },
    { type: 'param', name: 'H', value: h },
    // corners — deliberately sloppy start values, the solver must clean them up
    { id: '1', type: 'point', x: 0.3, y: -0.2, fixed: false },
    { id: '2', type: 'point', x: 41, y: 1.7, fixed: false },
    { id: '3', type: 'point', x: 38, y: 22, fixed: false },
    { id: '4', type: 'point', x: -1.2, y: 19, fixed: false },
    { id: '11', type: 'line', p1_id: '1', p2_id: '2' },
    { id: '12', type: 'line', p1_id: '2', p2_id: '3' },
    { id: '13', type: 'line', p1_id: '3', p2_id: '4' },
    { id: '14', type: 'line', p1_id: '4', p2_id: '1' },
    // anchor the sketch to the origin
    { id: '20', type: 'coordinate_x', p_id: '1', x: 0 },
    { id: '21', type: 'coordinate_y', p_id: '1', y: 0 },
    // shape
    { id: '22', type: 'horizontal_l', l_id: '11' },
    { id: '23', type: 'horizontal_l', l_id: '13' },
    { id: '24', type: 'vertical_l', l_id: '12' },
    { id: '25', type: 'vertical_l', l_id: '14' },
    // dimensions, driven by the NAMED params
    { id: '26', type: 'p2p_distance', p1_id: '1', p2_id: '2', distance: 'W' },
    { id: '27', type: 'p2p_distance', p1_id: '2', p2_id: '3', distance: 'H' },
  ]);
}

const corners = () => [1, 2, 3, 4].map((id) => {
  const p = gcs.sketch_index.get_sketch_point(String(id));
  return `(${p.x.toFixed(2)}, ${p.y.toFixed(2)})`;
}).join(' ');

// ---------------------------------------------------------------- 1. solve
console.log('\n=== 1. SOLVE a constrained profile');
rectangle(gcs, { w: 40, h: 20 });
let t = Date.now();
let status = gcs.solve();
gcs.apply_solution();
console.log(`  status ${STATUS[status]}  dof ${gcs.gcs.dof()}  in ${Date.now() - t} ms`);
console.log(`  corners ${corners()}`);
const p2 = gcs.sketch_index.get_sketch_point('2'), p3 = gcs.sketch_index.get_sketch_point('3');
console.log(`  measured W=${Math.hypot(p2.x, p2.y).toFixed(4)}  H=${Math.abs(p3.y - p2.y).toFixed(4)}`);

// ---------------------------------------------------------------- 2. parametric propagation
console.log('\n=== 2. PARAMETRIC PROPAGATION — change the named param, re-solve');
for (const w of [55, 12.5]) {
  gcs.set_sketch_param('W', w);
  t = Date.now();
  status = gcs.solve();
  gcs.apply_solution();
  const a = gcs.sketch_index.get_sketch_point('2');
  console.log(`  W := ${String(w).padEnd(5)} -> ${STATUS[status]}, measured ${Math.hypot(a.x, a.y).toFixed(4)} in ${Date.now() - t} ms`);
}

// ---------------------------------------------------------------- 3. under-constrained
console.log('\n=== 3. UNDER-CONSTRAINED detection (DOF)');
gcs.clear_data();
gcs.push_primitives_and_params([
  { id: '1', type: 'point', x: 0, y: 0, fixed: false },
  { id: '2', type: 'point', x: 30, y: 5, fixed: false },
  { id: '11', type: 'line', p1_id: '1', p2_id: '2' },
  { id: '20', type: 'coordinate_x', p_id: '1', x: 0 },
  { id: '21', type: 'coordinate_y', p_id: '1', y: 0 },
]);
gcs.solve();
console.log(`  free line, one end pinned -> dof ${gcs.gcs.dof()}  (expect 2: the far end)`);
gcs.push_primitives_and_params([{ id: '22', type: 'horizontal_l', l_id: '11' }]);
gcs.solve();
console.log(`  + horizontal                -> dof ${gcs.gcs.dof()}  (expect 1: length)`);
gcs.push_primitives_and_params([{ id: '23', type: 'p2p_distance', p1_id: '1', p2_id: '2', distance: 30 }]);
gcs.solve();
console.log(`  + length                    -> dof ${gcs.gcs.dof()}  (expect 0: fully constrained)`);

// ---------------------------------------------------------------- 4. conflicts
console.log('\n=== 4. CONFLICTING constraints — are they named?');
gcs.push_primitives_and_params([
  { id: '24', type: 'p2p_distance', p1_id: '1', p2_id: '2', distance: 45 },  // contradicts id 23
]);
status = gcs.solve();
console.log(`  status ${STATUS[status]}`);
console.log(`  has conflicts: ${gcs.has_gcs_conflicting_constraints()}`);
console.log(`  conflicting:   [${gcs.get_gcs_conflicting_constraints().join(', ')}]`);
console.log(`  redundant:     [${gcs.get_gcs_redundant_constraints().join(', ')}]`);

// ---------------------------------------------------------------- 5. perf
console.log('\n=== 5. PERFORMANCE — 60 chained rectangles (240 points, 360 constraints)');
gcs.clear_data();
const prims = [{ type: 'param', name: 'S', value: 10 }];
let pid = 1, cid = 1000;
for (let i = 0; i < 60; i++) {
  const b = pid;
  prims.push(
    { id: String(pid++), type: 'point', x: i * 12 + 0.4, y: 0.3, fixed: false },
    { id: String(pid++), type: 'point', x: i * 12 + 10.2, y: -0.1, fixed: false },
    { id: String(pid++), type: 'point', x: i * 12 + 9.7, y: 9.6, fixed: false },
    { id: String(pid++), type: 'point', x: i * 12 + 0.1, y: 10.4, fixed: false },
    { id: String(cid++), type: 'line', p1_id: String(b), p2_id: String(b + 1) },
    { id: String(cid++), type: 'line', p1_id: String(b + 1), p2_id: String(b + 2) },
    { id: String(cid++), type: 'line', p1_id: String(b + 2), p2_id: String(b + 3) },
    { id: String(cid++), type: 'line', p1_id: String(b + 3), p2_id: String(b) },
    { id: String(cid++), type: 'coordinate_x', p_id: String(b), x: i * 12 },
    { id: String(cid++), type: 'coordinate_y', p_id: String(b), y: 0 },
    { id: String(cid++), type: 'horizontal_l', l_id: String(cid - 6) },
    { id: String(cid++), type: 'vertical_l', l_id: String(cid - 6) },
    { id: String(cid++), type: 'p2p_distance', p1_id: String(b), p2_id: String(b + 1), distance: 'S' },
    { id: String(cid++), type: 'p2p_distance', p1_id: String(b + 1), p2_id: String(b + 2), distance: 'S' },
  );
}
gcs.push_primitives_and_params(prims);
t = Date.now();
status = gcs.solve();
gcs.apply_solution();
console.log(`  initial solve: ${STATUS[status]}, dof ${gcs.gcs.dof()}, ${Date.now() - t} ms`);
t = Date.now();
gcs.set_sketch_param('S', 14);
status = gcs.solve();
gcs.apply_solution();
console.log(`  param change + re-solve: ${STATUS[status]}, ${Date.now() - t} ms`);
