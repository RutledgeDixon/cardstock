# ADR-0003 — 2D constraint solver: PlaneGCS via WASM

**Status:** Accepted · **Date:** 2026-09-08 · **Phase:** 0 (Spike C)

## Context

Phase 6 (the sketcher) is the largest phase in the plan, and a geometric constraint
solver is the hard part of it. Writing one means a numerical Newton/Levenberg-Marquardt
solver plus degree-of-freedom analysis, conflict detection and redundancy detection —
months of work to reach the quality users take for granted. The alternative is to reuse
FreeCAD's PlaneGCS, the solver behind every FreeCAD sketch, compiled to WASM.

## Decision

Use **`@salusoft89/planegcs`** (v1.2.0), a WASM build of FreeCAD's PlaneGCS.

It lives in **`@cardstock/kernel`**, not `@cardstock/document`, behind a `SolverPort`
interface in `@cardstock/types` — the same treatment as OCCT, and for the same reason:
`document` stays pure so the sketch model can be unit-tested without WASM.
`tools/check-boundaries.mjs` now fails the build if `document` or `ui` imports it directly.

## Measurements

Run `node tools/spikes/planegcs-spike.mjs` to reproduce.

**Boot: 13 ms.** Negligible next to OCCT's 174 ms.

**Solving.** A rectangle given deliberately sloppy start points — (0.3, −0.2), (41, 1.7),
(38, 22), (−1.2, 19) — with horizontal/vertical/anchor/dimension constraints resolves in
**11 ms** to exactly (0,0) (40,0) (40,20) (0,20), dof 0.

**Parametric propagation, at sketch level.** Dimensions can reference *named parameters*
(`distance: 'W'`), and `set_sketch_param('W', …)` + re-solve updates the geometry in
**under 1 ms**. W := 55 measures 55.0000; W := 12.5 measures 12.5000. This is the
"change it and everything follows" promise, working at the sketch layer — and it maps
directly onto CARDstock's own parameter system.

**DOF reporting** is exact, which is what drives the under-constrained UI:

| sketch state | dof |
|---|---|
| line with one end pinned | 2 |
| + horizontal | 1 |
| + length | 0 (fully constrained) |

**Conflicts are named.** Two contradictory length constraints yield status `Failed`,
`has_gcs_conflicting_constraints() === true`, and `get_gcs_conflicting_constraints()`
returns `[23, 24]` — the offending constraint ids. Diagnostics can therefore point at the
exact constraints to delete rather than saying "over-constrained" and leaving the user to
hunt. Redundant and partially-redundant constraints have their own queries.

**Performance.** 60 chained rectangles (240 points, ~360 constraints): initial solve
**14 ms**, and a parameter change plus full re-solve **2 ms**. Comfortably interactive,
and far cheaper than the OCCT rebuild it will trigger (~62 ms per boolean, ADR-0001) —
so the solver will not be the bottleneck in sketch-driven editing.

## Consequences

- Phase 6 shrinks from "write a constraint solver" to "model sketches, infer constraints,
  and drive a solver" — the single largest de-risking in the plan.
- The full constraint catalogue we need exists: `p2p_coincident`, `horizontal_l`,
  `vertical_l`, `parallel`, `perpendicular_ll`, `tangent_*`, `equal`, `p2p_distance`,
  `p2l_distance`, `circle_radius`, `arc_radius`, `l2l_angle_ll`, `p2p_symmetric_*`,
  `point_on_line_pl`, `coordinate_x/y`, plus B-splines for later.
- **Ids must be strings.** The wrapper dispatches on `typeof val === 'string'` for
  `object_id` parameters; numeric ids fail with a misleading "unhandled parameter" error.
  `@cardstock/document` should therefore mint string ids for sketch entities.
- Licensing: PlaneGCS is LGPL, as is the OCCT build (ADR-0001). Fine for a WASM
  dependency loaded at runtime; worth a second look before any redistribution.
- The solver prints diagnostics to stdout (`Sketcher::RedundantSolving-DogLeg-`).
  Set `debug_mode = DebugMode.NoDebug` in the real integration.
