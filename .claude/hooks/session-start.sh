#!/bin/bash
# Cloud sessions start from a fresh clone with no node_modules: install so tests,
# lint and the dev server work from the first command. Local sessions are left alone.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"
# `npm ci`, not `npm install`: the container's npm is older than the one the lockfile
# is written with, and install would rewrite it (dropping `libc` fields) every session.
# Skipped when the cached container already matches the lockfile.
if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  npm ci --no-audit --no-fund --loglevel=error
fi
