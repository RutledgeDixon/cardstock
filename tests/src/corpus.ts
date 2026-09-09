import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The regression corpus.
 *
 * `.card` documents rebuilt on every CI run, asserted against recorded volume and
 * topology counts. This is the net for topological-naming regressions: a reference that
 * silently reattaches to a different edge changes the volume and the face count, but
 * nothing else in the test suite would notice, and a wrong part looks perfectly fine
 * until it comes off the printer.
 */

export const CORPUS_DIR = new URL('../../fixtures/', import.meta.url).pathname;

export interface Expectation {
  readonly name: string;
  readonly description: string;
  /** mm^3, compared within tolerance. */
  readonly volume: number;
  readonly faces: number;
  readonly edges: number;
  readonly vertices: number;
  /** Feature ids expected to build cleanly. */
  readonly ok: readonly string[];
}

export interface CorpusEntry {
  readonly name: string;
  readonly document: unknown;
  readonly expected: Expectation;
}

export function loadCorpus(): CorpusEntry[] {
  return readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith('.card'))
    .sort()
    .map((file) => {
      const name = file.replace(/\.card$/, '');
      return {
        name,
        document: JSON.parse(readFileSync(join(CORPUS_DIR, file), 'utf8')),
        expected: JSON.parse(
          readFileSync(join(CORPUS_DIR, `${name}.expected.json`), 'utf8'),
        ) as Expectation,
      };
    });
}
