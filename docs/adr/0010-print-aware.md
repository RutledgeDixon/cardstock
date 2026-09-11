# ADR-0010 — The print-aware suite

**Status:** accepted · **Phase:** 9

## Context

The thing this app knows that general CAD does not is that the part is going on an FDM
printer. Phase 9 makes that knowledge visible while modelling, not after export: what
will need support, what is too thin to print, whether it fits, which way up to put it,
and what it will weigh.

## Decisions

**The printer is app-wide, not part of the document.** A part is designed against a
nozzle and a bed, but it is the machine that has those, so the profile lives in the
app's store rather than in the `.card`. Two of its values reach expressions as the
environment names `nozzle` and `layer`: `wall = nozzle * 3` follows the printer. The
environment is a separate Map in the parameter table, consulted only when no parameter
has the name — the file wins over the machine, so a part can pin its own nozzle if it
must. Nothing tracks which expressions name an environment value; changing the printer
invalidates everything and rebuilds, which is cheap and rare.

**Analysis is shading, on the mesh already on the GPU.** Overhang and thickness are
modes of the solid material, not extra passes: a uniform picks the mode and the
fragment shader colours accordingly. Overhang is `-n.z` against `sin(maxOverhang)`,
amber to red past the limit; surface facing down within half a layer of the model's
lowest point is the first layer and reads green, so the footprint is visible for free.
The bed is wherever the model's lowest point is — the part is assumed to be placed on
the plate, not floating above it — because a slicer will drop it there anyway.

**Thickness is measured, not estimated.** From each vertex, a ray is cast inward along
the negated normal through the BVH already built for picking; the first hit is the far
wall. It runs on the CPU, once, when the mode is switched on, and writes a per-vertex
attribute the shader reads. A slab reads its own thickness on its faces and its width
on its edges — that is the measurement, not a defect. The limit is two nozzle widths:
the least a wall can be printed with.

**The build volume is a reference, not a constraint.** A wireframe box on the grid,
centred, from the bed up; the part is free to sit anywhere, and *fits* is judged by its
dimensions in any axis-aligned orientation, because the slicer will place it. The box
goes red and the status bar says which bed it does not fit.

**Orientation is scored, and applied to the export only.** Candidates are the
directions of the part's larger flat regions — each put face-down — plus the six axes,
deduplicated. Each is scored on a coarse mesh: overhang area past the limit, the support
column beneath it (projected area × drop, ignoring occlusion), first-layer contact, and
height, normalised against the worst candidate and weighted 0.5 / 0.3 / 0.1 / 0.1.
Support dominates because it is what wastes filament and scars the surface. The weights
are opinions, stated in the code so they can be argued with. Applying a suggestion
rotates the exported file through `kernel.transform` on a temporary handle; the model
is never touched, and the export dialog says which way it is going out.

**Estimates say "solid".** Volume from mass properties, mass from the profile's density,
filament length from its diameter — for a solid part. A real print has infill and this
is the ceiling; the status bar says so.

## Verification

The profile normaliser, `fitsBed`, the estimates, and the environment (shadowing,
removal) are unit-tested. Thickness is tested on a slab: minimum equals its thickness,
nothing reads under it. Orientation is tested on a bracket (pure) and on a real T made
of two boxes (OCCT): the flat side wins, the flipped one reports support. In the
browser, the smoke run builds a mushroom and reads pixels: the underside paints warm,
the stem's foot paints green, shading switches off cleanly; thickness measures the
stem; the build volume goes red for a 300 mm plate; the scorer wants the mushroom
upside down; the exported STL comes out rotated while the model does not; `nozzle *
100` evaluates to 40 and rebuilds to 60 after the printer dialog changes the nozzle.

## Not yet

Small-hole compensation as a printer setting (holes already take an explicit fit).
Occlusion in the support estimate. A first-layer outline drawn as a curve rather than
as green surface. Per-face thickness that accounts for infill.
