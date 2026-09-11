import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

/**
 * Build identity, baked in at build time.
 *
 * The About dialog needs to say WHICH build you are looking at — a version alone cannot,
 * because most testing happens between releases. `git describe` is read here rather than
 * at runtime because the browser has no repository to ask.
 */
const read = (command: string, fallback: string) => {
  try {
    return execSync(command, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || fallback;
  } catch {
    return fallback;
  }
};

const app = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};
const kernel = JSON.parse(
  readFileSync(new URL('../kernel/package.json', import.meta.url), 'utf8'),
) as { dependencies: Record<string, string> };

const strip = (v: string) => v.replace(/^[\^~]/, '');

export default defineConfig({
  // Tauri attaches to this port and expects it not to move; keep its own output quiet
  // so the shell's logs stay readable.
  server: { port: 5173, strictPort: true },
  clearScreen: false,
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  resolve: { preserveSymlinks: false },
  define: {
    __BUILD__: JSON.stringify({
      version: app.version,
      commit: read('git rev-parse --short HEAD', 'unknown'),
      dirty: read('git status --porcelain', '') !== '',
      date: new Date().toISOString().slice(0, 10),
      occt: strip(kernel.dependencies['replicad-opencascadejs'] ?? '?'),
      planegcs: strip(kernel.dependencies['@salusoft89/planegcs'] ?? '?'),
      three: strip(
        (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
          dependencies: Record<string, string>;
        }).dependencies.three ?? '?',
      ),
    }),
  },
});
