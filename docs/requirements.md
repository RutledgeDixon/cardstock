# Requirements

Accumulated from the user, in their words where it matters. The phase plan lives at
`~/.claude/plans/this-is-a-big-delightful-goose.md`; this is the running list of
specifics that plan does not spell out.

## Settled and built

- Browser web app; OpenCascade WASM kernel; full 2D constraint solver for the sketcher.
- The 3D viewer is the app. Chrome is minimal and at the edges.
- Rotation is arrow keys, roll-free by construction. *(Phase 1)*
- Change an early value and it propagates through the whole model. *(Phase 2)*
- Reorder rewires the primary chain rather than being presentational. *(Phase 2)*

## Toolbar — one level deep, right edge, no submenus ever

Feature *variants* live in the feature's parameter panel, never in a submenu.

Two buttons specified explicitly:

- **Sketch** — starts a sketch on the selected face. With nothing selected it asks for a
  plane: XY, XZ, YZ, or "pick a face".
- **Export** — STL for now. The dialog gains other formats later (3MF, STEP, OBJ), but
  the button stays one button.

## Editing dimensions: typed inputs, not sliders

> "I want the controls for editing the dimensions of an object to be inputs, not
> sliders. That way I can get really precise whenever I need to."

Numeric text fields are the primary control for every dimension. A slider may only ever
be a secondary affordance next to a field, never the only way to set a value. Fields
accept expressions, since parameters already support them (`wall * 3`, `boltM3 + 0.4`).

The Phase 3 demo used sliders purely to exercise the rebuild loop; they are replaced when
the real UI lands in Phase 5.

## Radial context menu

Right-clicking a face or an edge offers the operations for that entity: fillet, chamfer,
constraints, and so on. Contents derive from what is under the cursor, with stable sector
positions per context so a command is always in the same direction.

## Moving and relating objects in 3D

> "I want it to be easy to move objects around in 3d space, as well as
> connect/constrain them to each other."

Two distinct constraint systems, deliberately different in character:

| | 2D sketch constraints | 3D object constraints |
|---|---|---|
| Where | inside a sketch | between bodies in the model |
| Character | **strict** — solved exactly, DOF-tracked, conflicts reported | **optional** — guidance rather than law |
| Solver | PlaneGCS (ADR-0003) | to be designed |
| Phase | 6 | new work; see below |

The 3D system is closer to assembly mates (coincident faces, concentric axes, offset,
parallel, flush) but must not become a hard constraint solver that refuses to let you
move something. The user's framing is that these are "more optional than the strict rules
for 2D constraints" — so they should behave as snapping and maintained relationships that
can be overridden, not as invariants that block direct manipulation.

This is a real addition to the original plan, which had assemblies only as a Phase 11
stretch. It needs its own phase between the feature set and the print-aware suite, plus a
direct-manipulation move gizmo that respects but does not obey the constraints.
