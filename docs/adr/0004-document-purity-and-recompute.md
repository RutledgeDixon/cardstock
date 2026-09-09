# ADR-0004 — A pure part model, and how it rebuilds

**Status:** Accepted · **Date:** 2026-09-08 · **Phase:** 2

## Context

`@cardstock/document` owns the parameters, the feature graph, the recompute engine,
undo, serialisation, and — from Phase 4 — topological naming. That is the most
intricate logic in the project and the least amenable to being debugged through a
viewport.

## Decision

The package imports **nothing but `@cardstock/types`**. No OCCT, no three.js, no React,
no DOM. Geometry is reached only through the `KernelPort` interface, and a `MockKernel`
implements it in memory.

`tools/check-boundaries.mjs` enforces this in CI. The 160 unit tests run in Node in
under half a second, with no WASM and no browser.

## Why it earns its keep

The mock records every call, so tests assert not just the final state but **which
features rebuilt and in what order** — the actual contract of an incremental engine, and
something no screenshot could show. Mock volumes combine arithmetically (a cut subtracts
the tool's full volume regardless of overlap): deliberately not physically accurate, but
*predictable*, which is what makes assertions meaningful.

## The three properties that matter

**Only the dirty branch rebuilds.** The feature list is ordered but dependencies form a
DAG: a feature depends on the parameters its expressions read and the features its inputs
name. The exit-criteria fixture is deliberately branched rather than a chain —

```
width ──> box ──┐
                ├──> cut ──> fillet ──> move
       cylinder ┘
```

— because a chain would pass even with a naive "rebuild everything after the edit"
implementation. Editing `width` rebuilds `box, cut, fillet, move` and provably skips
`cylinder`; editing `holeRadius` does the mirror image.

**Results are content-addressed.** Each feature caches under a hash of its type, resolved
values, selections and *input hashes*. Scrubbing a parameter back to a previous value
performs zero kernel calls, and undo inherits that for free — no special handling, the
old hashes are simply still warm. Two features with identical inputs share one result.

**Failure is local.** A failed feature falls back to its primary input, so a bad fillet
leaves the un-filleted solid on screen and everything downstream still builds. Root
primitives have no fallback, so their failure correctly *blocks* dependents rather than
pretending. Errors name the feature and the offending value
(`radius: unknown parameter "nonsense"`), never just "rebuild failed".

## Decisions worth recording

- **Reorder rewires the primary chain.** Inputs are explicit ids, so the list order is
  not itself the dependency — but a drag still performs the edit the user means: the
  moved feature takes its new predecessor's place in the chain, and the feature that
  consumed it bypasses it. Same visible behaviour as SolidWorks, with one crucial
  difference: the rebinding is an explicit, recorded, undoable edit rather than an
  emergent side effect of an array index, so Phase 4 can see the references change and
  a move that cannot work is refused with a reason instead of silently producing a
  wrong part.

  It splices the **primary chain**, not the raw list. In `Box, Drill, Hole, Round` the
  cylinder sits between the box and the cut in the list, but it is a boolean *tool*, not
  a step in the chain; splicing against list neighbours would hand the fillet a cylinder
  to operate on. Splicing against the chain skips side inputs, and — being a chain —
  cannot produce a cycle. Secondary inputs keep their bindings, because "which solid does
  this cut with" is not something a drag in a list can express. Walking the chain stops
  at a fork for the same reason. A move that would leave a feature displayed above
  something it depends on is refused: the graph would still build it correctly, but a
  tree that reads in an order the model does not follow is just confusing.
- **Trigonometry is in degrees.** Every CAD package works that way; radians would be a
  foot-gun with no upside.
- **Expressions are parsed, never `eval`'d.** A document is a file people share, so an
  expression is untrusted input. Parsing is also the only way to answer "which parameters
  does this reference?", which the graph needs. The evaluator additionally rejects
  non-numeric scope results — a `Scope` backed by a plain object resolves `constructor`
  to `Object` rather than `undefined`, and that must never reach geometry.
- **Ties in topological order break by document position**, not node id. Order is not
  unique; ranking by tree position makes independent branches rebuild in the order the
  user sees, instead of falling out of alphabetics.
- **Undo is snapshot-based.** A `.card` holds no geometry, so a snapshot is a small plain
  object. Rapid edits sharing a coalesce key merge, so dragging a slider is one undo step
  — and undo keeps the *oldest* state in the run, jumping back past the whole drag rather
  than to its penultimate frame.
- **The cache is bounded.** After each rebuild, hashes no live feature references are
  released. Cheap in the mock; real memory inside OCCT.

## Known gap

`@cardstock/types` and `@cardstock/document` set `main` to TypeScript source, which suits
bundlers and Vitest but means plain `node` cannot import the built `dist` by package
name. Irrelevant today; Phase 10's headless `.card` → STL CLI will need either a
`dist`-pointing export condition or to run through `tsx`.

## Amendment — recomputes are serialised (post-review)

A user reported the app stuck on "rebuilding…" forever after changing a revolve's axis.
The mechanism turned out to be three faults stacked, and the geometry was innocent — the
same model rebuilds cleanly in Node.

**Recomputes overlapped.** Cancellation is checked *between* features, so a run already
past its last check finishes regardless and two runs are genuinely concurrent. That was
harmless until the kernel gained allocation scopes (ADR-0007), which are a **stack** and
assume scopes nest. Interleaved, they attribute allocations to the wrong run and free the
newest run's published shape: `beginScope, beginScope, revolve→s15, revolve→s16,
endScope([s15]), endScope([s16])` — and s16, recorded in the scope the first endScope
popped, was gone before anything could tessellate it.

Recomputes are now serialised behind an in-flight promise. Cancellation stays: the token
is minted **synchronously** in `recompute()`, not inside the queued body, because a token
created after the await does not exist yet when the next edit tries to cancel it — every
keystroke would then rebuild in full.

**Eviction could free a handle its consumer still held.** Tessellation happens after
recompute returns, so the next edit's eviction could collect a shape the previous rebuild
was still reading. `evict` now keeps one generation of slack, which removes the race
rather than narrowing it.

**And nothing caught the throw.** `doRebuild` had no `try/finally`, so any rejection left
`busy` true and the status bar stuck with no way back short of a reload. There were also
*two* rebuild paths with the same omission — the sketching one and the modelling one —
and only one would ever have been noticed. They are now one function, guarded by a
generation counter (a superseded run publishes nothing, and reports nothing, since its
failure is expected) and a `finally` that only the newest run may clear.

A bug is bad; a bug that bricks the session until a reload is worse.
