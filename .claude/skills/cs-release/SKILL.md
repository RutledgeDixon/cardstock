---
name: cs-release
description: Ship CARDstock — run the full checks and the browser smoke, push to GitHub, tag a test release, and confirm the Linux and Windows installers were built. macOS is not built. In cloud sessions, pushes the session branch and opens a PR instead of pushing master.
---

# CARDstock: check, push, release

Use after one or more `/cs-change` commits, when the user wants a build testers can download.
Argument: an optional tag (default: next `v<version>-testN`).

## 1. Full checks (all of them, once)

```bash
npm run typecheck && npm run lint && npm run boundaries && npm test
```

Fix anything that fails before going on. Do not push red.

## 2. Full browser smoke

Every check must pass. It takes ~1–2 minutes. Restart the dev server first if it was
already running (stale transforms).

**Without preview tools** (cloud sessions, a plain terminal) — one command, against the
dev server started as in `/cs-change` step 4:

```bash
node tools/pw-drive.mjs --smoke          # prints "smoke: N passed, 0 failed"; non-zero exit on any failure
```

**With the preview tools** (local desktop sessions):

1. `preview_start` name `cardstock`.
2. `cp tools/browser-smoke.js packages/app/public/__smoke.js`
3. Navigate to `http://localhost:5173/?fresh=1`, wait ~4 s, then in `javascript_tool`:
   ```js
   window.confirm = () => true;
   const src = await fetch('/__smoke.js').then(r => r.text()); (0, eval)(src);
   window.__smokeResult = null;
   window.__smoke().then(r => { window.__smokeResult = r; }, e => { window.__smokeResult = { error: String(e) }; });
   ```
   Poll in separate `javascript_tool` calls of ≤40 s
   (`await new Promise(r => setTimeout(r, 40000)); window.__smokeResult`) until it resolves.
   `rm packages/app/public/__smoke.js` afterwards (it is gitignored).

## 3. Push

```bash
git status --short          # must be clean
```

**Local session:** `git push origin master`. `~/.local/bin/gh` is installed and
authenticated (scopes: repo, workflow).

**Cloud session:** never push master. Push the branch the session was told to develop
on (`git push -u origin <branch>`) and, if the user wants it, open a PR with the GitHub
MCP tools (`mcp__github__create_pull_request`). Tagging a release from a cloud session
needs the user's say-so: the tag points at whatever commit you push it from.

Repo: https://github.com/RutledgeDixon/cardstock (private).

## 4. Tag and build

Tags `v*` trigger `.github/workflows/release.yml`, which builds **Linux** (`.deb`, `.rpm`,
`.AppImage`) and **Windows** (`.msi`, `-setup.exe`) and attaches them to a pre-release.
macOS is deliberately not built.

```bash
git tag <tag> && git push origin <tag>
~/.local/bin/gh run list --workflow "Desktop build" --limit 1
```

Watch it in the background (~10 min; Windows is the slow one). Without `gh` (cloud
sessions), the same information comes from `mcp__github__actions_list` /
`mcp__github__actions_get` for the run and jobs, `mcp__github__get_job_logs` for a
failure, and `mcp__github__get_release_by_tag` for the assets.

```bash
until ~/.local/bin/gh run view <run-id> --json status --jq .status | grep -q completed; do sleep 30; done; ~/.local/bin/gh run view <run-id> --json jobs --jq '.jobs[] | "\(.name): \(.conclusion)"'
```

Then list the assets:

```bash
~/.local/bin/gh release view <tag> --json assets --jq '.assets[].name'
```

## 5. Report

Give the release URL `https://github.com/RutledgeDixon/cardstock/releases/tag/<tag>` and the
asset names. Remind the user that the repo is private: testers need collaborator access, or
send them the files. If a job failed, read its log with `gh run view <run-id> --log-failed`,
fix, commit, and re-tag with the next N.
