# Topological naming

The spec, written before the implementation. This is the subsystem that makes "change an
early sketch and it propagates" true, and the one that makes FreeCAD painful when it is
wrong.

## The problem

You fillet edge 7 of a box. You widen the box. OCCT rebuilds it and hands back a shape
whose edges are numbered differently. A reference stored as "edge 7" now points at a
different edge — and it fails *silently*, producing a valid-looking part with a fillet in
the wrong place.

## Two problems, not one

The literature treats this as one problem. It is two, with different solutions, and
conflating them is why naive implementations only half-work.

**1. Cross-feature mapping.** The reference names an entity of feature A's output, but
the feature that needs it consumes B, where B derives from A. Example: you pick an edge
of the box, then a fillet operates on `cut(box, cylinder)`. The edge still exists, but its
index in the cut result differs.

*Solved by provenance.* OCCT's `Generated`/`Modified`/`IsDeleted` say exactly how each
operation mapped input sub-shapes onto output sub-shapes. Replaying that chain is exact
when the history is available. Captured per-input since Phase 3 — face 0 of a box and
face 0 of the cylinder cutting it are unrelated, so the histories cannot share a keyspace.

**2. Same-feature re-identification.** Feature A itself rebuilt with different
parameters. The box is still a box, but a wider one.

*Provenance does not help here at all*, because a primitive rebuild has no history: the
old shape and the new shape are unrelated objects with no operation between them. This is
the case fingerprints exist for, and it is the common one — every parameter edit hits it.

## The reference

```
TopoRef {
  kind:        face | edge | vertex
  origin:      { featureId, index }   -- where it was picked, for provenance replay
  fingerprint: EntityFingerprint      -- what it looked like, for re-identification
}
```

### Fingerprints

Captured at pick time and stored in the document. The coordinates are **normalised
against the shape's bounding box**, which is the key choice: a corner edge of a box sits
at bbox-fraction (0, 0, *) whether the box is 40mm or 55mm wide. That makes the
fingerprint invariant to exactly the edit that breaks index-based references.

| field | why |
|---|---|
| `geometryType` | plane/cylinder/line/circle… — a hard filter, never a score |
| `centroidNormalised` | position within the bounding box, translation- and scale-invariant |
| `direction` | face normal or edge axis; orientation survives resizing |
| `measureRatio` | area or length relative to the shape's total; robust to scale |
| `neighbourTypes` | sorted geometry types of adjacent faces; distinguishes lookalikes |

## Resolution

1. **Provenance first.** If the reference's origin feature is upstream of the shape being
   resolved against, replay the history chain. Exact when available.
2. **Fingerprint fallback.** Score every candidate of the right kind. Type must match.
3. **Never guess.** The best candidate must clear an absolute confidence threshold *and*
   beat the runner-up by a margin. If it does not — or if two candidates tie — the
   reference is marked **broken**, not silently reattached.

A broken reference fails the feature loudly, which the Phase 2 engine already handles
locally: the feature falls back to its input, downstream keeps building, and the tree
shows exactly what needs fixing. Repair is re-picking the entity, which mints a fresh
fingerprint.

## Why "never guess" is the important rule

A wrong fillet that looks plausible is worse than a missing one. The user prints the
part before noticing. Refusing to resolve is recoverable in ten seconds; a silently
misplaced feature is a wasted print and an hour of confusion.

## Testing

The resolver is pure logic over fingerprints and history maps, so it is unit-testable
against `MockKernel` with no geometry at all. On top of that, `fixtures/*.card` are
rebuilt in CI and asserted for stable volume and topology counts — the net that catches
naming regressions, which are otherwise invisible until they ruin a part.
