# CARDstock

**C**omputer **A**ssisted **R**apid **D**esign — *stock*, as in bare, no-frills.

A browser-based parametric solid modeller with one job: sit down, design a part, print it.

Narrower than FreeCAD on purpose. No assemblies, no drawings, no CAM — just fast
parametric part design that knows the part is going on an FDM printer.

## Three commitments

**It knows the part is going on a printer.** Overhang shading is live in the viewport
while you model, not a post-export check. Build volume is always visible, wall thickness
is measured against your actual nozzle diameter, and the app can tell you which face to
put down.

**Navigation is roll-free by construction.** SolidWorks and FreeCAD orbit feels wrong
because their trackballs introduce *roll* — the model tumbles and you lose up. CARDstock
uses a turntable (azimuth + elevation, up-vector locked), so roll is not representable.
Arrow keys aren't a downgrade; they're the honest input for a 2-DOF camera.

**Right-click is the primary verb.** A radial menu whose contents come from what's under
the cursor, with stable sector positions per context, so a command is always in the same
direction. The toolbar is one level deep. There are no submenus anywhere.

## Architecture

```
@cardstock/ui  +  @cardstock/commands     React shell, radial menu, toolbar
                      |
@cardstock/document                       parameters, feature graph, recompute,
                      |                   topological naming, undo, serialization
                      |                   PURE TS — no OCCT, no three.js
                      | KernelPort
@cardstock/kernel  +  @cardstock/viewer   OCCT in a Web Worker; three.js rendering
@cardstock/types                          shared contracts
@cardstock/app                            composition root
```

The load-bearing rule is that `@cardstock/document` never imports OCCT, three.js, React
or the DOM. That is what makes the recompute engine and topological naming unit-testable
in Node against a `MockKernel` — the only realistic way to get them right.
`npm run boundaries` enforces it in CI.

## Development

```bash
npm install
npm run dev          # dev server
npm test             # unit tests
npm run typecheck    # project-wide tsc
npm run boundaries   # architectural layering check
```

## Status

**Phase 1** — the viewer. Keyboard-first turntable navigation, and face/edge/vertex
picking against a static tessellation fixture. `npm run dev`, then point at the model
and press Tab to cycle what you can select.

Phase 0 (foundations and de-risking spikes) is complete — see `docs/adr/` for the
decisions and `tools/spikes/` for the measurements behind them. Phase 2 builds the
document model and recompute engine; Phase 3 replaces the fixture with the live kernel.

Part files are `.card`.
