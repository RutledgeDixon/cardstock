#!/usr/bin/env node
/**
 * Architectural boundary check.
 *
 * The load-bearing rule of CARDstock is that @cardstock/document — the part model,
 * recompute engine and topological naming — is pure TypeScript. It must never reach
 * for OCCT, three.js, React or the DOM. That is what keeps it unit-testable in Node
 * against a MockKernel, which is the only realistic way to get the recompute graph
 * and topological naming correct.
 *
 * This runs in CI. Violations fail the build.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

/** Which internal packages each package may import. */
const ALLOWED = {
  types: [],
  document: ['types'],
  kernel: ['types'],
  viewer: ['types'],
  commands: ['types', 'document'],
  ui: ['types', 'document', 'commands', 'viewer'],
  app: ['types', 'document', 'kernel', 'viewer', 'commands', 'ui'],
};

/** External packages each package may NOT import, with the reason. */
const BANNED = {
  types: [
    ['three', 'types is a pure contract package'],
    ['opencascade.js', 'types is a pure contract package'],
    ['react', 'types is a pure contract package'],
  ],
  document: [
    ['three', 'the part model must not know about rendering'],
    ['opencascade.js', 'the part model talks to KernelPort, never to OCCT directly'],
    ['react', 'the part model must not know about the UI'],
    ['zustand', 'the part model owns its own state, not a UI store'],
  ],
  commands: [
    ['three', 'commands describe intent; they do not render'],
    ['opencascade.js', 'commands go through the document, never straight to the kernel'],
  ],
  viewer: [
    ['react', 'the viewer is framework-agnostic and must stay embeddable'],
    ['opencascade.js', 'the viewer consumes tessellated meshes, not B-rep'],
  ],
  kernel: [['three', 'the kernel emits plain typed arrays, not scene objects']],
};

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts)$/.test(p)) out.push(p);
  }
  return out;
}

const violations = [];

for (const pkg of Object.keys(ALLOWED)) {
  const srcDir = join(ROOT, 'packages', pkg, 'src');
  let files;
  try {
    files = walk(srcDir);
  } catch {
    continue; // package has no src yet
  }

  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const where = relative(ROOT, file);

    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2];
      if (!spec) continue;

      // Internal cross-package imports.
      const internal = spec.match(/^@cardstock\/([a-z]+)/);
      if (internal) {
        const target = internal[1];
        if (target !== pkg && !ALLOWED[pkg].includes(target)) {
          violations.push(
            `${where}\n    imports @cardstock/${target}, but ${pkg} may only import: ` +
              `${ALLOWED[pkg].join(', ') || '(nothing)'}`,
          );
        }
        continue;
      }

      // Banned external dependencies.
      for (const [banned, reason] of BANNED[pkg] ?? []) {
        if (spec === banned || spec.startsWith(banned + '/')) {
          violations.push(`${where}\n    imports "${spec}" — ${reason}`);
        }
      }
    }
  }
}

if (violations.length) {
  console.error(`\n  Architectural boundary violations (${violations.length}):\n`);
  for (const v of violations) console.error('  ' + v + '\n');
  process.exit(1);
}
console.log('  Architecture boundaries OK.');
