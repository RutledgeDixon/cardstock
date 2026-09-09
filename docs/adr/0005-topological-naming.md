# ADR-0005 — Topological naming

**Status:** Accepted · **Date:** 2026-09-08 · **Phase:** 4

## Context

The single highest-risk subsystem in the project, and the one that makes FreeCAD painful
when it is wrong. Full design in `docs/toponaming.md`; this records the decisions and
what implementing them taught us.

## Decision

References are `TopoRef`: an origin (for provenance replay) plus a fingerprint (for
re-identification). Resolution tries provenance, then fingerprint, then **refuses**.

The resolver lives in `@cardstock/document` and is pure — it sees fingerprints and
history maps, never geometry — so every branch is unit-testable in Node. The kernel's job
is only to produce the raw material: `describeShape` for fingerprints, `captureHistory`
for provenance.

## The reframing that made it tractable

The literature treats this as one problem. It is two, and they need different mechanisms:

| | mechanism | when |
|---|---|---|
| Cross-feature mapping — an entity of A's output, needed against downstream B | provenance replay | a feature is inserted or the chain changes |
| Same-feature re-identification — A itself rebuilt with new parameters | fingerprints | **every parameter edit** |

Provenance is useless for the second case, and the second case is the common one: a
primitive rebuild has no history at all, because the old and new shapes are unrelated
objects with no operation between them. An implementation built only on OCCT history —
the obvious reading of the problem — would fail on the most ordinary edit in the app.

## Fingerprints: normalised coordinates are the load-bearing idea

Coordinates are expressed as fractions of the shape's bounding box. A corner edge sits at
bbox-fraction (0, 0, ·) whether the box is 40mm or 55mm wide, which makes the reference
invariant to precisely the edit that breaks index-based ones. Verified directly: the four
vertical edges of a 40mm and a 55mm box produce identical normalised coordinates.

Geometry type is a **hard filter, never a weight**. Letting a strong positional match
outvote "a plane is not a cylinder" is how resolvers end up attaching a fillet to the
wrong kind of thing.

## Refusing is a feature

A winner must clear an absolute threshold *and* beat the runner-up by a margin. A
near-tie means the model genuinely contains two similar entities, and choosing one
silently is worse than stopping — a wrong fillet that looks plausible gets printed before
anyone notices, whereas a refused one is re-picked in ten seconds. Refusals carry ranked
candidates so a repair UI can offer them.

This composes with the Phase 2 engine at no extra cost: a broken reference is just a
feature error, so the feature falls back to its input, downstream keeps building, and the
tree shows exactly what needs fixing.

## Three traps, all found by tests rather than by reasoning

**"Unchanged" does not mean "same index".** OCCT records only what an operation
*changed*, and reading a missing entry as "still itself, at the same index" is wrong: an
operation can leave an edge untouched while the shape renumbers around it. Carrying the
index forward then resolves to a real, valid, unrelated edge — the silent misplacement
this entire subsystem exists to prevent. Caught by the integration test; the unit test had
encoded the same wrong assumption and so agreed with the bug. An absent mapping now ends
the trail and hands the question to fingerprinting.

**A deleted edge still generates.** A filleted edge reports `IsDeleted() === true` *and*
generates the fillet surface. Treating deletion as a reason to stop querying discarded the
most valuable mapping the operation produces.

**Provenance is verified, not trusted.** A traced index is scored against the fingerprint
before acceptance, because a history map can be right that an entity survived and wrong
about where it landed.

## Verification

`@cardstock/tests` is a workspace outside the layering, because the integration test needs
both document and kernel and neither may import the other.

The exit criterion passes against real geometry: fillet a chosen corner, then resize it,
resize it four more times, insert a hole beneath it, save and reload. The fillet stays put
every time. Shrink the box until the fillet is impossible and it fails loudly, falls back,
lets the rest of the model build, and recovers on undo.

`fixtures/*.card` are rebuilt in CI against recorded volume and topology counts — the net
for regressions that are otherwise invisible, since a misattached reference still builds
and still looks fine. The net is verified sensitive: perturbing one expectation by the
volume of a single fillet (155 mm³) fails the run. Regenerate with `npm run corpus` after
a deliberate change, and read the diff.
