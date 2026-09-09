import { beforeAll, describe, expect, it } from 'vitest';
import { Document } from '@cardstock/document';
import { createOcctKernel, type OcctKernel } from '@cardstock/kernel';
import { loadCorpus } from './corpus.js';

/**
 * Rebuild every corpus document and compare against its recorded geometry.
 *
 * A topological-naming regression reattaches a reference to a different edge. The model
 * still builds, the app still looks fine, and the volume and face count quietly change.
 * Nothing else in the suite would notice.
 */
let kernel: OcctKernel;
beforeAll(async () => { kernel = await createOcctKernel(); }, 60_000);

const corpus = loadCorpus();

it('the corpus is not empty', () => {
  expect(corpus.length).toBeGreaterThan(0);
});

describe.each(corpus)('$name', ({ document, expected }) => {
  it(expected.description, async () => {
    const doc = Document.fromJSON(document, kernel);
    const result = await doc.recompute();

    const failures = [...result.states.values()]
      .filter((s) => s.status !== 'ok')
      .map((s) => `${s.id}: ${s.status}${s.message ? ` — ${s.message}` : ''}`);
    expect(failures).toEqual([]);
    expect([...result.states.values()].map((s) => s.id)).toEqual(expected.ok);

    const terminal = [...result.states.values()].at(-1)!;
    const mass = await kernel.massProperties(terminal.handle!);
    const counts = await kernel.topologyCounts(terminal.handle!);

    // Volume is the sensitive one: a reference that moved to another edge changes it.
    expect(mass.volume).toBeCloseTo(expected.volume, 3);
    expect(counts).toEqual({
      faces: expected.faces, edges: expected.edges, vertices: expected.vertices,
    });
  }, 30_000);
});
