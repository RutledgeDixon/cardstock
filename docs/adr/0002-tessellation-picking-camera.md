# ADR-0002 — Face-tagged tessellation, BVH picking, and the turntable camera

**Status:** Accepted · **Date:** 2026-09-08 · **Phase:** 0 (Spike B)

## Context

Two of CARDstock's three commitments were unproven assumptions:

1. *"Right-click is the primary verb"* requires that a pixel under the cursor resolve
   back to a specific **OCCT face**, not just a triangle.
2. *"Navigation is roll-free by construction"* requires that the turntable camera
   genuinely cannot introduce roll — a claim, until measured.

## Decision

Tessellate per-face and carry a **per-triangle face id** alongside the merged buffers,
plus the same id as a **per-vertex attribute**. Build the BVH with `{ indirect: true }`.
Camera is a turntable with the up-vector locked to +Z and elevation clamped to ±(π/2 − 0.01).

## The bug this spike existed to catch

`three-mesh-bvh`'s `computeBoundsTree()` **reorders the index buffer in place** — measured:
1126 of 1188 index entries changed, diverging from entry 0. So `hit.faceIndex` refers to
the *reordered* triangle list, and the obvious `triangleFaceId[hit.faceIndex]` silently
returns the wrong topological face. It is silent because it still returns *a* valid face
id, so every face-based operation would have been subtly wrong for as long as it took
someone to notice.

The fix has a second trap inside it. With `{ indirect: true }` the BVH leaves our index
order alone — and `hit.faceIndex` is then **already** in original order. Also calling
`bvh.resolveTriangleIndex()` double-maps it. Measured over 4589 rays:

| resolution method | agreement with per-vertex attribute |
|---|---|
| `triangleFaceId[hit.faceIndex]` | **4589 / 4589** |
| `triangleFaceId[resolveTriangleIndex(hit.faceIndex)]` | 986 / 4589 |

So: `indirect: true`, then index directly. The per-vertex `faceId` attribute is kept as an
independent cross-check (all three vertices of every hit triangle share one id — 4589/4589),
and doubles as the shader's hover mask.

## Tessellation

Verified on a box with a Ø12 through-hole and four r3 filleted corners (11 faces):

- Every face produces geometry; every triangle carries exactly one face id.
- All normals unit length. OCCT supplies none by default — call `ComputeNormals()`.
- Faces come back `TopAbs_REVERSED`; winding **and** normals must be flipped.
  The check that catches getting this wrong: signed volume of the triangle soup
  (21586.1) against the B-rep volume (21583.5) — 0.01%, pure tessellation error.
  Skip that check and inverted winding looks fine until something is shaded or exported.

## Camera — the roll-free claim, measured

Screen-right must stay horizontal in world terms, i.e. its Z component must be 0. Across
the start view, all seven named views, eight snap-orbits and twenty attempts to push past
the elevation clamp: **max |screen-right.z| = 0, exactly.** Elevation clamps as designed.
Snap-orbit is exact (8 × 15° = 2.094 rad added to 0.785 → 2.880).

**Degeneracy at the poles.** With up locked to +Z, looking straight down leaves the up
reference nearly parallel to the view direction, so screen orientation is decided entirely
by azimuth — it works out to `screen-right = (-sin az, cos az, 0)`. The top view was
initially built with `az = 0`, which puts **X vertical**: wrong by CAD convention and
visibly wrong on screen. Top and bottom must use `az = -π/2` to get X-right, Y-up.
Any future "snap to this face" command has the same trap when the face normal is ±Z.

## Consequences

- `@cardstock/kernel` tessellation must emit `{positions, normals, indices, triangleFaceId, edges}`.
  Edges are extracted separately via `BRepAdaptor_Curve` — CAD reads as edges, not triangles.
- `@cardstock/viewer` owns the `indirect: true` rule. It is not optional and not obvious;
  it is the kind of thing that gets "cleaned up" by someone who doesn't know why it's there.
- The interaction loop is split into `advance(dt)` so it can be stepped deterministically
  from a test harness. `requestAnimationFrame` does not run while a pane is hidden, so any
  future Playwright camera test must step explicitly rather than wait on frames.

## Addendum — fat lines and a cached instance count

Sketch geometry is drawn with three's `LineSegments2`, because `LineBasicMaterial`'s
`linewidth` is ignored by every WebGL implementation that matters.

**Reusing the geometry silently draws the wrong number of segments.** Three caches
`_maxInstanceCount` on an `InstancedBufferGeometry` when it first binds that geometry's
vertex attributes, and calling `setPositions` again — which replaces those attributes —
does not invalidate it. The renderer draws `min(instanceCount, _maxInstanceCount)`.

A sketch redrawn after each click therefore locked `_maxInstanceCount` to 1 on the first
line and never rendered another, while `instanceCount` climbed correctly. Every layer
above agreed the lines existed: the tools reported them, the sketch held them, the profile
closed, the solver counted their degrees of freedom. Only the pixels disagreed.

The fix is a FRESH `LineSegmentsGeometry` per update, disposing the old — disposal is what
drops the cached bindings. Sketches are tens of entities and already redraw wholesale, so
the allocation costs nothing measurable.

The lesson is the one this file keeps relearning: a rendering bug can be invisible to
every assertion about state. The smoke test now reads back actual pixels for the first and
a later segment, because nothing short of that would have caught it.
