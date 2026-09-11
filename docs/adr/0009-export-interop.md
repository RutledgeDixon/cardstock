# ADR-0009 — Export and interop

**Status:** accepted · **Phase:** 8

## Context

Phase 8's exit criterion is an STL that opens in a slicer, verifies watertight, and
measures right. Until now Export was one button that wrote a binary STL at a fixed
quality, and the only way to find out whether the mesh was closed was to load it into
the slicer. Nothing came back in: there was no way to model against a part someone
else made.

## Decisions

**One mesh pipeline, welded.** Every mesh format — STL binary and ASCII, 3MF, OBJ — is
tessellated once at the chosen quality and encoded in TypeScript from the same welded,
indexed mesh. The tessellator produces one vertex run per B-rep face, so a vertex on a
shared edge exists once per face that meets there; STL does not care, but 3MF and OBJ
do — a slicer reading duplicated vertices sees an open shell along every edge and
"repairs" it, sometimes wrongly. Welding by quantised position (four decimals) merges
them so the exported mesh is closed *as a mesh*, not just as geometry. OCCT's own STL
writer is no longer used: it welds nothing and cannot be asked how many triangles it
wrote.

**3MF is offered because it is what a slicer would rather have.** It carries units, so
"is this in inches?" never comes up, and its mesh is indexed, so the welded topology
survives into the slicer. The writer is the core spec only: one object, one build item,
no colours or materials. It needs a ZIP container, which is written by a hundred-line
store-only encoder rather than a dependency — the XML compresses well but slicers do not
mind the size, and a compression library is not worth carrying into a worker bundle.

**STEP goes through OCCT** (`STEPControl_Writer`, `AsIs`) and ignores quality; it is
the B-rep itself. STEP import (`STEPControl_Reader`, `TransferRoots`, `OneShape`) is
exact and units are converted to millimetres by the reader.

**Watertightness is checked before writing.** The dialog counts triangles live as the
quality numbers change, and reports whether every directed edge has exactly one partner
running the other way — the definition of a closed, consistently wound surface, and the
first thing a slicer checks. Quality is two typed numbers (max deviation in mm, max
facet angle in degrees) with three presets; the consequence of a number is shown before
the file is written, not discovered in the slicer.

**Imports live inside the feature.** A `.card` stores no geometry of its own — the model
is rebuilt from history — but an import has no history, so the file's contents ride
along in the feature's values: STEP as text, STL as base64. A self-contained part is the
right trade for a file people move between machines; the cost is a larger `.card`. The
recompute cache hashes the contents like any value, so the import is re-read only when
it changes, which is never. The panel does not show these as fields.

**STL import makes a solid, up to a limit.** `StlAPI_Reader` gives one face per
triangle; sewing them into a shell and closing it is what makes the result usable in a
boolean or a mass-properties query, and it is slow — roughly quadratic in practice.
Past 50 000 triangles the import is refused with the count, rather than accepted and
left to hang. STL is imported to model against, not to edit.

**Export is a dialog, not a button.** Format, quality, and — when there is more than one
body — whether to write all of them or the selected ones. Settings outlive the dialog.

## Verification

Encoders are golden-tested on a hand-built cube: 24 vertices weld to 8, 12 triangles,
watertight, signed volume 1, first facet normal −z, OBJ 1-based, 3MF parts in order,
CRC-32 against the reference value. OCCT round trips: STEP export → import preserves
volume and face count; STL export → import of a box gives a 6000 mm³ solid with 12
faces; a faceted cylinder comes back within 5%. In the browser, the dialog opens, counts
live, reports watertight, and writes through the stubbed save picker; a STEP written by
the app imports back as a second body that Combine can cut with.

## Not yet

Orientation recommendation in the export dialog (Phase 9). Colours and materials in
3MF. Import of assemblies as separate bodies — `OneShape` compounds them.
