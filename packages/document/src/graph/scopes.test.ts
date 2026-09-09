import { describe, expect, it } from 'vitest';
import { asFeatureId } from '@cardstock/types';
import { Document } from '@cardstock/document';
import { MockKernel } from '../mock-kernel/mock-kernel.js';

/**
 * A feature's intermediates must not outlive it.
 *
 * OCCT objects are manually managed, so a shape allocated on the way to an answer and
 * never freed stays in the WASM heap for the whole session. Measured before this existed:
 * a 20-copy pattern leaked twenty shapes per rebuild and grew linearly for as long as a
 * dimension was scrubbed.
 */
const id = (s: string) => asFeatureId(s);

function patternDoc(kernel: MockKernel, copies: number): Document {
  const doc = new Document(kernel);
  doc.setParameter({ name: 'gap', expression: '15', unit: 'mm' });
  doc.addFeature({
    id: id('unit'), type: 'box', name: 'Unit',
    values: { dx: '10', dy: '10', dz: '10' }, inputs: {},
  });
  doc.addFeature({
    id: id('pat'), type: 'linearPattern', name: 'Pattern',
    values: { count: String(copies), spacing: 'gap', dx: '1' },
    inputs: { base: id('unit') },
  });
  return doc;
}

describe('feature compute is scoped', () => {
  it('frees the copies a pattern makes, keeping only its result', async () => {
    const kernel = new MockKernel();
    const doc = patternDoc(kernel, 8);
    const result = await doc.recompute();
    const output = result.states.get(id('pat'))!.handle!;

    // Seven copies were made and fused; none of them is the answer.
    expect(kernel.released.length).toBeGreaterThanOrEqual(7);
    expect(kernel.released).not.toContain(output);
    // The feature's own input survives: it was allocated in an earlier scope.
    expect(kernel.released).not.toContain(result.states.get(id('unit'))!.handle!);
  });

  it('does not grow without bound when a parameter is scrubbed', async () => {
    const kernel = new MockKernel();
    const doc = patternDoc(kernel, 8);
    await doc.recompute();

    const after = async (edits: number) => {
      for (let i = 0; i < edits; i++) {
        doc.setParameter({ name: 'gap', expression: String(15 + i), unit: 'mm' });
        await doc.recompute();
      }
      return kernel.liveShapes;
    };

    const at20 = await after(20);
    const at60 = await after(40);
    // Twenty more edits of a 8-copy pattern would have added 140+ shapes before scoping.
    expect(at60 - at20).toBeLessThan(60);
  });

  it('frees the debris of a feature that FAILED', async () => {
    // A pattern that throws part way through has still allocated copies. Nothing else
    // will ever reference them, so the failure path has to clean up too.
    const kernel = new MockKernel();
    const doc = new Document(kernel);
    doc.addFeature({
      id: id('unit'), type: 'box', name: 'Unit',
      values: { dx: '10', dy: '10', dz: '10' }, inputs: {},
    });
    await doc.recompute();
    // Snapshot AFTER the box exists, so the only change under test is the failure.
    const before = kernel.liveShapes;

    doc.addFeature({
      id: id('pat'), type: 'linearPattern', name: 'Pattern',
      // Over the 200-copy limit: the feature refuses after the engine opened its scope.
      values: { count: '900', spacing: '15', dx: '1' }, inputs: { base: id('unit') },
    });
    const result = await doc.recompute();
    expect(result.states.get(id('pat'))!.status).toBe('error');
    // The box is still there; nothing else was left behind.
    expect(kernel.liveShapes).toBe(before);
  });

  it('keeps a handle a feature passed straight through from its input', async () => {
    // A suppressed or pass-through feature returns its INPUT. Freeing that would take
    // the model out from under everything downstream.
    const kernel = new MockKernel();
    const doc = new Document(kernel);
    doc.addFeature({
      id: id('unit'), type: 'box', name: 'Unit',
      values: { dx: '10', dy: '10', dz: '10' }, inputs: {},
    });
    doc.addFeature({
      id: id('move'), type: 'move', name: 'Move',
      values: { dx: '0', dy: '0', dz: '0' }, inputs: { base: id('unit') },
    });
    const result = await doc.recompute();
    const box = result.states.get(id('unit'))!.handle!;
    expect(kernel.released).not.toContain(box);
    expect(result.states.get(id('move'))!.status).toBe('ok');
  });
});
