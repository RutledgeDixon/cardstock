# ADR-0001 — Geometry kernel: OpenCascade WASM, replicad's trimmed build

**Status:** Accepted · **Date:** 2026-09-08 · **Phase:** 0 (Spike A)

## Context

CARDstock needs a B-rep kernel. B-rep, not mesh CSG, because the core interaction is
right-clicking a *face* or an *edge* and doing something to it, and because Phase 4's
topological naming depends on persistent, queryable topology. The candidate was
`opencascade.js`, whose full build ships a **62.8 MB** wasm — large enough that it could
have invalidated the browser-app decision outright. This spike measured it before
anything was built on top.

## Decision

Use **`replicad-opencascadejs`** (v1.1.0) — a purpose-trimmed OCCT build — loaded inside
a Web Worker, rather than the full `opencascade.js` build.

## Measurements

Run `node tools/spikes/occt-spike.mjs` to reproduce. Node 24, this machine:

| | full build | trimmed build |
|---|---|---|
| wasm, raw | 62.8 MB | **21.9 MB** |
| wasm, brotli-11 | 9.0 MB | **4.8 MB** |
| exported symbols | ~9000 | 500 |

| operation | time |
|---|---|
| module boot | 174 ms |
| `MakeBox` 40×30×20 | 2 ms |
| boolean cut (Ø12 through-hole) | 62 ms |
| fillet r4 on one edge | 20 ms |
| tessellate @ 0.05 mm deflection | 12 ms |

Geometry verified numerically, not just "it ran": box volume exactly 24000; after the
centred Ø12 through-hole, 21738.1 = 24000 − π·6²·20.

**4.8 MB brotli, cached after first visit, is an acceptable price for a real B-rep kernel.**

## The finding that mattered

Phase 4 (topological naming) lives or dies on OCCT's history API, and a *trimmed* build
is exactly where such a thing would have been trimmed away. It survives:

```
Generated(edge0)         -> 1 face      (the fillet surface)
Modified(face0)          -> 1 replacement
IsDeleted(face0)         -> false
BRepAlgoAPI_Cut.Modified -> 1           (booleans carry history too)
```

Provenance-based topological naming is viable on this build. This was the single
highest-risk assumption in the whole project plan.

## Consequences

**Boolean cost sets the architecture.** At ~62 ms per boolean, a ten-feature model is a
~600 ms rebuild. That is precisely why the plan's dirty-propagation and
content-addressed cache are not premature optimisation — they are what makes parameter
scrubbing interactive. Confirmed, not assumed.

**We do not control the build.** replicad trims for *replicad's* API needs, not ours. One
roadmap symbol is already missing (`BRepBuilderAPI_Copy`; workaround is
`BRepBuilderAPI_Transform` with an identity transform). If we hit a wall, producing our
own custom build requires Docker, which is not installed on this machine — that would be
a CI job. Revisit if a second symbol goes missing.

## API notes for `@cardstock/kernel` (hard-won; not in any documentation)

- **No `_1`/`_2` overload suffixes.** embind dispatches by arity: `new MakeBox(dx,dy,dz)`,
  `fil.Add(radius, edge)`. Likewise `TopLoc_Location`, `Message_ProgressRange`,
  `BRepMesh_IncrementalMesh` — plain names.
- **Handles are auto-dereferenced.** `BRep_Tool.Triangulation(face, loc, 0)` returns a
  `Poly_Triangulation` directly. No `.IsNull()`, no `.get()`. Test with truthiness.
  Note the third argument is required.
- **No `TopTools_*` and no `TopExp` namespace** — only `TopExp_Explorer`. The
  `NCollection_IndexedMap_*` equivalents are exported but **not constructible**
  (unbound base `NCollection_BaseMap`). Get unique sub-shapes by exploring and deduping
  with `IsSame`. O(n²), fine at part scale; revisit if a shape reaches thousands of faces.
- **`TopExp_Explorer` yields duplicates** — a box gives 24 edge visits for 12 edges, one
  per adjacent face. Always dedupe.
- **`NCollection_List_TopoDS_Shape` has no bound iterator.** Drain it destructively via
  `First()` / `RemoveFirst()`. History calls return a fresh list each time, so this is safe.
- Every OCCT object needs explicit `.delete()` — the refcounted handle registry in
  `@cardstock/kernel` exists to make that systematic rather than ad hoc.

## Phase 7 addendum — sweeping

**`BRepOffsetAPI_MakePipe` requires a G1-continuous spine, and does not say so.** Given a
path with a right-angle corner it swept only the first leg and returned a perfectly valid
solid of exactly the wrong size — no exception, no `IsDone()` of false. `MakePipeShell`
with an explicit `SetTransitionMode(BRepBuilderAPI_RightCorner)` handles corners, and
mitres them so the swept volume is exactly the path length times the section.

**`MakePipeShell.Add` takes a WIRE, not a face.** Handed a face it raises
`BRepFill_Section: bad shape type of section`. Sketches arrive as faces, so the profile
goes through `asWire` first. `MakeSolid()` then caps the ends; `Build()` alone leaves a
shell with no volume.

**`WithContact: true` moves the profile.** It translates the section until it touches the
spine, which quietly moved a section centred on a radius-20 path out to radius 21 and
changed the volume by 5%. It is false here: the profile stays where it was drawn.

**`BRepOffsetAPI_DraftAngle` reports failure through `AddDone()`, not by throwing.** A
face it cannot taper — anything but planar, cylindrical or conical — is accepted by
`Add()` and then poisons `Build()`. Each face is checked as it goes in, so the error can
name which one.
