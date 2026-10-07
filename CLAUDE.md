# CARDstock

Browser-based parametric solid modeller for FDM printing; also ships as a Tauri desktop
app. See `README.md` for the pitch and `docs/adr/` for why things are the way they are.

## Layering (enforced by `npm run boundaries`)

`types` (contracts) → `document` (pure model, sketch, recompute, toponaming — **never**
imports OCCT, three.js, React or the DOM) → `kernel` (OCCT in a Web Worker, PlaneGCS
adapter) / `viewer` (three.js) → `commands` (registry) → `ui` (React, no geometry) →
`app` (composition root).

## Where things live

- `packages/app/src/App.tsx` — React shell: state, the boot effect, `createHost({...})`, render.
- `packages/app/src/wiring/` — `host.ts` (command host), `sketch-session.ts` (sketch
  editing), `file-controller.ts` (new/open/save/recents/boot restore), `exporter.ts`,
  `model-bridge.ts` (document → kernel → viewer rebuild), `label-layout.ts`, `boot.ts`.
- `packages/document/src/sketch/*` — sketch model and tools; `commands/src/registry/builtins.ts` — commands.
- `packages/app/src/style.css` — every colour is a `:root` token; the viewport takes `--bg`.
- New kernel capability: `types/src/kernel.ts` → `kernel/src/occt/kernel.ts` →
  `kernel/src/rpc/client.ts` → stub in `document/src/mock-kernel/mock-kernel.ts`.
- New command: `builtins.ts` + `commands/src/registry/host.ts` + `app/src/wiring/host.ts`
  + the dep in `App.tsx`'s `createHost`.

## Standing UI rules

Typed inputs, never sliders. Tool panel on the right edge. Submenus exactly one level
deep (the registry enforces it). The radial ring only in 3D space and as the sketch
selection ring. Escape puts a sketch tool down.

## Checks

```bash
npx tsc -b && npx vitest run <file-or-package>   # the narrow check for a change
npm run check                                    # typecheck + lint + boundaries + all tests
node tools/pw-drive.mjs --smoke                  # full browser smoke, dev server on :5173
```

`tools/pw-drive.mjs` drives the running app in headless Chromium (`--js`, `--shot`,
`--smoke`, `--csp`); the harness globals are `__host`, `__doc`, `__viewer`, `__kernel`,
`__registry`, `__session()`, `__rebuild()`, `__step(n)`. Restart the dev server after
editing workspace sources — Vite serves stale transforms.

## Workflow

Use `/cs-change` for any change (edit, narrow test, browser check if visible, local
commit) and `/cs-release` to run everything, push and build installers. Comments explain
*why*, in the voice already in the file.
