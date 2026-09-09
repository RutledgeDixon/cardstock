# ADR-0007 — What makes this slow, and what was done about it

**Status:** Accepted · **Date:** 2026-09-09 · **Phase:** 7 (review)

## Context

The app felt fine on the models built while developing it, which were small. A benchmark
(`tools/bench.ts`) built the shapes people actually model for a printer — a plate with a
bolt grid, a pattern of parts on a plate, a deep feature chain — and measured a build, an
edit to a root parameter, and a tessellation for each.

The first run found two things that were not slow but broken-slow, and both were the same
mistake in different clothes: **doing N times what could be done once.**

## The four costs

**Sequential booleans.** A 150-copy pattern fused its copies one at a time and took
**two minutes**. Each fuse re-solves the intersection graph of everything already fused,
so the work is quadratic in the copy count with a very large constant. OCCT's
multi-argument form (`SetArguments` / `SetTools` on a `BRepAlgoAPI_*`) builds that graph
once: the same 150 copies now fuse in **246ms**, and `booleanMany` exists on the port so
nothing has to rediscover this.

**O(n²) sub-shape dedupe.** `TopExp_Explorer` yields duplicates, so `subShapes` deduped by
comparing each visit against everything kept — `IsSame` on every pair. On a 900-face
shape that was 6.5M comparisons and it dominated *everything* that enumerates topology:
tessellation 2.5s, `describeShape` 3.4s. Bucketing by quantised bounding box makes the
comparison local; `IsSame` still decides, so coincident-but-distinct shapes (a cylinder's
seam edge) stay distinct. Tessellation **2515 → 274ms**.

`NCollection_IndexedMap` would have been the natural fix and is not constructible in this
build (ADR-0001); `TopExp::MapShapesAndAncestors` is not bound either. Hence the bucket.

**A linear scan inside a loop.** `describeShape` built its edge→face adjacency with
`findIndex(IsSame)` per edge per face. `shapeIndexer` buckets the haystack once by the
same key. **3391 → 296ms.**

**Worker round trips.** A 100-copy pattern made 99 `transform` calls, each a separate
message to the worker, before any geometry existed. `transformMany` makes it one:
**103 kernel calls per rebuild → 8.**

## The leak

Every OCCT object is manually managed. The document releases the handles it *caches* —
but a feature typically allocates more shapes than it returns: a hole makes a drill
cylinder, a pattern makes a copy per instance. Those had no owner and stayed in the WASM
heap for the life of the session. Measured: **a 20-copy pattern leaked 19.7 shapes per
rebuild**, growing linearly for as long as a dimension was scrubbed.

The fix is a scope, not a rule. `ShapeRegistry.beginScope()` records allocations;
`endScope(keep)` frees everything except what the feature published. The recompute engine
wraps each `compute` in one, so a new feature gets this for free rather than having to
remember — and the `finally` means a feature that *failed* still has its debris
collected. A feature that passes an input straight through is safe: that handle was
allocated in an earlier scope.

After: a 400-edit scrub of a patterned, drilled part plateaus at **127 live shapes** —
the content cache's limit — and stays flat.

## Where it still costs

**Sequential cuts do not batch across features.** 144 separate hole features on one plate
take 5.8s, because each is its own boolean against a progressively more complex solid.
That is inherent to one-feature-per-hole; the answer for a bolt grid is a *patterned*
hole, which is one feature and one multi-cut. Not built yet.

**Tessellation is proportional to what is on screen**, and re-runs for the whole body on
any change. Incremental tessellation is Phase 10.

## An environment finding, not a fix

In the automated browser pane, a rebuild that takes ~190ms normally takes ~5000ms roughly
every fifth time, landing on whichever kernel call is in flight. It is **not** the code:

- the identical workload in Node is rock steady at 226–253ms across 30 rebuilds, zero stalls
- a plain JS worker doing comparable work in the same page shows no stalls at all
- the stall does not correlate with shape count, cache size, or the amount of work

That isolates it to the OCCT WASM worker *in that browser environment* — a background,
unfocused page which was already measured to throttle `requestAnimationFrame` to one frame
every eight seconds. Whether a real focused browser window shows it is untested and needs
a human at a keyboard. `kernel.stats()` reports the live shape count so a leak can be
told apart from a stall when it does happen.

The heap size is deliberately not reported: this OCCT build exposes neither `HEAP8` nor
`wasmMemory` on the module, and a number that is always zero is worse than no number.
