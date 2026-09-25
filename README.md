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
direction. The toolbar is one level deep — a group opens a flyout of leaves, and a leaf
may never itself be a group, which the registry enforces at registration.

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

## Desktop app

The desktop build wraps the same web app in a [Tauri](https://tauri.app) shell with its
own parts directory (`~/Documents/CARDstock`) and a `.card` file association. It needs
Rust and, on Linux, the WebKitGTK development headers:

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

Then, from the repo root:

```bash
npm run desktop -w @cardstock/app
```

runs it against the dev server, and

```bash
npm run desktop:build -w @cardstock/app
```

produces installers under `packages/app/src-tauri/target/release/bundle/` — `.deb`,
`.rpm` and `.AppImage` on Linux; `.msi`/`.exe` on Windows. Each platform builds its own
installer; there is no cross-compiling. Windows installers are unsigned until a
code-signing certificate is configured, so Windows will warn on first run.

Testers do not need any of that: pushing a `v*` tag runs `.github/workflows/release.yml`,
which builds the Linux and Windows installers and attaches them to a pre-release.
macOS is deliberately not built.

The desktop window runs under a Content-Security-Policy (`tauri.conf.json`): only the
app's own scripts, workers and assets, plus Tauri's IPC. It allows `unsafe-eval` because
OCCT's bindings in the kernel worker compile functions from strings.

Installing a newer build over an older one replaces it: the Windows setup detects the
existing install and upgrades it in place (the product name and identifier are what
tie the two together — keep `productName` and `identifier` in `tauri.conf.json`
stable), and `.deb`/`.rpm` upgrade through the package manager. The `.AppImage` has no
installer; a new one is just a new file. An in-app updater would need the release
assets to be publicly fetchable, which a private repository's are not.

## Status

**Phases 0–9 complete.** `npm run dev` gives a working parametric modeller: sketches
with a constraint solver, extrude / revolve / sweep / loft, fillet / chamfer / shell /
draft, holes from a fastener table, patterns, booleans across separate bodies, undo,
`.card` files with autosave and recents, and export to STL, 3MF, OBJ and STEP with a
live triangle count and watertight check. STEP and STL can be imported to model
against. The print suite shades overhangs and thin walls live, draws the build volume,
scores orientations and applies one to the export, and estimates mass and filament; the
printer's `nozzle` and `layer` are usable in any dimension. A Tauri desktop shell with its
own parts directory and `.card` association builds Linux and Windows installers from
CI (see *Desktop app* above).

See `docs/adr/` for the decisions, `tools/browser-smoke.js` for the in-browser checks,
and `tools/bench.ts` for the measurements.

Phase 10 is under way: performance, polish, and a tutorial for the keyboard navigation.

Part files are `.card`.
