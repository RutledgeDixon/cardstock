---
name: cs-change
description: Change, fix or add something in CARDstock efficiently — locate, edit, run only the tests that cover it, verify in the browser only if it is visible, commit locally. Never pushes.
---

# CARDstock: make a change

Use for any code change in this repo. The goal is the smallest set of steps that
proves the change works. Do NOT push, tag, or touch GitHub here — that is `/cs-release`.

## 1. Orient (read, don't re-derive)

- Packages: `types` (contracts) → `document` (pure model, sketch, solver-facing, no OCCT/three/DOM)
  → `kernel` (OCCT in a worker, PlaneGCS adapter) / `viewer` (three) → `commands` (registry)
  → `ui` (React, no geometry) → `app` (wiring: `App.tsx`, `wiring/host.ts`, `wiring/sketch-session.ts`).
- Layering is enforced by `tools/check-boundaries.mjs`. Document never imports OCCT/three/React.
- Standing UI rules: typed inputs, never sliders; right-edge toolbar; submenus exactly one level;
  ring menu only in 3D space and the sketch selection ring; Escape puts a sketch tool down.
- Find the code with Grep before assuming where it lives. Most user-visible behaviour is in
  `packages/app/src/App.tsx` (large), `wiring/sketch-session.ts`, `packages/document/src/sketch/*`,
  `packages/commands/src/registry/builtins.ts`.

## 2. Edit

- Match surrounding style. Comments explain *why*, in the voice already in the file.
- New kernel/solver capability: add to `packages/types/src/kernel.ts`, implement in
  `kernel/src/occt/kernel.ts` or `kernel/src/solver/planegcs.ts`, add to `kernel/src/rpc/client.ts`,
  stub in `document/src/mock-kernel/mock-kernel.ts`.
- New command: `commands/src/registry/builtins.ts` + host hook in `commands/src/registry/host.ts`,
  `app/src/wiring/host.ts`, and the dep in `App.tsx`'s `createHost({...})`.

## 3. Test — only what the change touches

Pick the narrowest of these that covers the change; run ONE, two at most:

```bash
npx tsc -b && npx vitest run <path/to/the/test/file(s)>     # a package or a specific test file
```

- document/sketch logic → `packages/document/src/sketch/…test.ts` or `packages/document`
- solver → `packages/kernel/src/solver/planegcs.test.ts` (real PlaneGCS, fast)
- OCCT geometry → the relevant `packages/kernel/src/occt/*.test.ts`
- end-to-end sketch→solid → `tests/src/sketch-to-solid.test.ts`
- commands/registry → `packages/commands`

Add or adjust a test when the change has a behaviour worth pinning; keep it small.
Do not run the whole suite (`npm test`) and do not run lint here unless the change is
wide; `/cs-release` does both.

## 4. Verify in the browser — only if the change is visible

Skip entirely for kernel/document-only changes. Otherwise:

1. `preview_start` name `cardstock`; navigate to `http://localhost:5173/?fresh=1`.
   **Restart the server after workspace source edits** (Vite serves stale transforms).
2. Wait ~3 s, then drive the app with the harness globals via `javascript_tool`:
   `window.__host`, `__doc`, `__viewer`, `__kernel`, `__registry`, `__session()`, `__rebuild()`,
   `__step(n)`. Set `window.confirm = () => true` first. Real pointer input: dispatch
   `PointerEvent`s on `__viewer.canvas` at coordinates from
   `session.view.toWorld(p).project(viewer.camera)`.
3. Check the ONE thing the change is for (a DOM query, a state read, a pixel readback).
   Do not run the full smoke script here — that is `/cs-release`.

## 5. Commit locally

```bash
git add -A && git commit -q -m "<what and why, one paragraph>

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Then report: what changed, what was verified (test names / the browser check), and anything
left for the user to judge. No push.
