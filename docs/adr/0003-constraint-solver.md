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

## Amendment: reference dimensions, more distance kinds, and faces from a graph

**A new dimension is a reference.** Placing one shows the value as drawn and pins
nothing — it is dropped from the solve, so it takes no freedom away. Typing into it
makes it drive: the `reference` flag comes off, the label turns green, and the DOF
count goes down by one. Placing a dimension to *see* a length must never move the
sketch or lock it by accident.

**Two picks make a dimension, and the pair decides its kind.** Point–point is a
distance; point–line the gap; two parallel lines their spacing (with parallelism pinned
alongside, so the number keeps meaning something when driven) and two others their
angle; a circle against a line or a point measures from the rim, via PlaneGCS's
`c2ldistance` and `p2cdistance`. A circle picked twice, or once and then empty space,
is its radius.

**Profiles are faces of a planar graph**, not chains. Every segment is two half-edges;
from each unused one, walk by taking the leftmost turn at every vertex. Bounded regions
come out counter-clockwise, the outside of each connected piece clockwise and is
dropped. A junction is no longer "ambiguous": two triangles sharing a corner are two
regions, each its own face, and the kernel extrudes the compound into two solids.
Regions nest one level — a loop inside another is its hole — and the containment
sample is taken just inside an edge, because a shared vertex would test as inside both.
Loose segments still report as a gap, and three meeting at a point with nothing closed
is still refused rather than swept along a Y.

## Amendment: external references

A sketch can constrain against what it sits on. On an origin plane that is the two
axes through the origin; on a face it is the face's edges and corners, read from the
kernel (`faceOutline`) and projected into the sketch plane. They arrive as ordinary
sketch entities — fixed points, construction lines and circles — carrying an `external`
key, so every existing constraint works against them and nothing new is needed in the
solver beyond pinning an external circle's radius. The sketch feature re-projects them
on every rebuild before solving, keyed so a corner stays the same entity when the body
changes: a point coincident with it follows, and a constraint against an edge that no
longer exists fails loudly like any reference to deleted geometry. External geometry is
drawn muted, is pickable, cannot be dragged or deleted, and is never part of a profile.

## Amendment: what a drag is allowed to move

Dragging is the one place where a constraint solver's freedom works against it. Every
configuration satisfying the rules is equally valid, so "which one" is a question the
constraints do not answer, and the answer a user expects is: the one nearest where the
sketch already was.

The first implementation could not express that. It offered the cursor position as the
dragged point's initial *guess*, and a guess is only a suggestion — the solver would
undo it whenever putting the point back was the smaller change, so a rigid but
untethered shape barely followed the pointer. The compensation was to translate the
point's whole connected component — everything the constraint graph could reach —
before solving, and that is what made dragging feel unpredictable: the solver then
settled on the nearest solution to a state in which the entire sketch had already
moved, so geometry with no relationship to the drag kept the offset. Pull the end of an
arc and the far side of the part slid sideways with it.

The drag is now expressed as a **pin**: the dragged point becomes a fixed point at the
cursor, and DogLeg, starting from the sketch's current positions, moves the minimum it
can around it. That is the whole rule — a free point moves alone, a point tied to a
line brings the line, a rigid floating sketch translates entire — and none of it is
special-cased; it falls out of least-squares from where the sketch already was.

A pin fails when the point cannot reach the cursor at all: the free end of a horizontal
line dragged upwards, or a sketch with no freedom left, both turn "it cannot go there"
into a contradiction. So a failed pin falls back to the old seeded guess **without any
pre-translation**, which lets the constraints pull the point back onto what is
reachable — that end tracks in x and stays put in y, and a finished sketch does not move
at all. Two attempts, each well under a millisecond, and the crisp one is used exactly
when the freedom for it exists.

Two guards remain outside the solver: only points are draggable (never lines, never
curves), and a solved result in which any point moved more than a few times the
pointer's own travel is discarded as a jump to another solution branch rather than a
drag. Whether a point can move is left to the solver rather than read from the DOF
count, which can be a solve behind.

## Amendment: arcs measure themselves, and curves are divisible

Two changes that both come of asking geometry to say what it is rather than propping it
up with extra geometry.

**An arc's sweep is its own.** An arc used to be built on an AXIS: a construction line
between its two ends, two radii hung off the centre, and a sweep measured from the axis's
perpendicular bisector. That needed a sign convention for which side of the axis the
bulge fell on, a rule for when the arc's ends WERE the axis ends (state it twice and the
solver reports a conflict), two distance constraints holding the axis ends on the circle,
cascade rules so deleting either took the other, and a pick tie-break for the points that
ended up stacked. All to express one number the arc already carries. The sweep is now
`end angle − start angle`, solved as a plain difference of the arc's own two angle
parameters, and its SIGN is the direction — which is exactly what the side-of-the-axis
rule was standing in for. Drawing an arc is two clicks, each taking an existing point or
making one, with a driving sweep of 180°; add a radius dimension too and the ends give
instead. Schema 3 migrates v2 files, reading the new signed value from the angles the
file actually drew so no old convention has to be re-derived, and leaving the axis line
in place as an ordinary construction line because files hold constraints on it.

**A curve is cut by the points that lie on it.** The face tracer turns corners only where
segments share an end, so a curve another one merely touched part-way along was a wall:
a chord across a circle enclosed nothing, and a line running into the middle of another
left both sides open — a limitation a test recorded rather than fixed. Each curve is now
split at the points sitting on it, at the same tolerance that decides whether two ends
meet, and the regions follow from the existing trace with nothing else changed. Cuts are
deduplicated by position: a sketch has coincident points everywhere, and cutting twice in
one place leaves a zero-length piece, which is a self-loop in the graph that stops the
trace dead.

One thing this does NOT yet change is what a click selects. Picking a rim still selects
the whole circle, so a constraint placed on it applies to the whole circle. Splitting the
selection too would mean deciding what a constraint on one piece means for the rest,
which is a question about the model, not about picking.
