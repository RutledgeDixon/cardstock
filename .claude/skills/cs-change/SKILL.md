---
name: cs-change
description: Change, fix or add something in CARDstock efficiently — locate, edit, run only the tests that cover it, verify in the browser only if it is visible, commit locally. Never pushes.
---

# CARDstock: make a change

Use for any code change in this repo. The goal is the smallest set of steps that
proves the change works. Do NOT push, tag, or touch GitHub here — that is `/cs-release`.

## 1. Orient (read, don't re-derive)

`CLAUDE.md` has the layering, where things live, and the standing UI rules. Find the
code with Grep before assuming where it lives.

## 2. Edit

- Match surrounding style. Comments explain *why*, in the voice already in the file.
- New kernel capability or command: follow the paths listed in `CLAUDE.md`.

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

Skip entirely for kernel/document-only changes. Otherwise check the ONE thing the change
is for (a DOM query, a state read, a pixel readback, a screenshot). Do not run the full
smoke here — that is `/cs-release`.

The app exposes harness globals: `window.__host`, `__doc`, `__viewer`, `__kernel`,
`__registry`, `__session()`, `__rebuild()`, `__step(n)`. Set `window.confirm = () => true`
first. Real pointer input: dispatch `PointerEvent`s on `__viewer.canvas` at coordinates
from `session.view.toWorld(p).project(viewer.camera)`. Always load `/?fresh=1`, or the
app restores the last autosave.

**Restart the dev server after workspace source edits** — Vite serves stale transforms.

**With the preview tools** (local desktop sessions): `preview_start` name `cardstock`,
navigate to `http://localhost:5173/?fresh=1`, wait ~3 s, then use `javascript_tool`.

**Without them** (cloud sessions, a plain terminal): run the dev server in the
background and drive it with `tools/pw-drive.mjs` (headless Chromium via Playwright;
stubs `confirm` for you):

```bash
setsid npm run dev > /tmp/dev.log 2>&1 < /dev/null & echo $! > /tmp/dev.pid   # start
kill -- -$(cat /tmp/dev.pid)                                                   # stop, before a restart
node tools/pw-drive.mjs --js "return __doc.features.length" --shot /tmp/shot.png
```

Playwright is preinstalled in cloud sessions; elsewhere `npm i -g playwright && npx
playwright install chromium` once. `--js` is an async function body (`return` the answer); `--js-file` takes a file. Read
the screenshot to look at it. Stop the server by its pid — `pkill -f vite` also matches
and kills the shell running it.

## 5. Commit locally

```bash
git add -A && git commit -q -m "<what and why, one paragraph>

<the attribution trailer(s) this session specifies>"
```

Use the co-author/attribution lines your session's instructions give; do not copy a
model name from an old commit.

Then report: what changed, what was verified (test names / the browser check), and anything
left for the user to judge. No push.
