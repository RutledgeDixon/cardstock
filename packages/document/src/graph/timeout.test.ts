import { describe, expect, it } from 'vitest';
import { asFeatureId, KernelTimeoutError } from '@cardstock/types';
import { Document } from '../document.js';
import { MockKernel, mockTopoRef } from '../mock-kernel/mock-kernel.js';

/**
 * A feature whose build hung is not tried again until something about it changes.
 *
 * The watchdog stops a hung fillet after its limit, but every rebuild after that — an
 * unrelated parameter, an undo — would run straight into the same fillet and wait the
 * whole limit again, which is what "stuck rebuilding" looks like from the outside.
 */
const id = asFeatureId;

class HangingKernel extends MockKernel {
  hangs = 0;
  override async fillet(shape: never, edges: readonly number[], radius: number) {
    if (radius === 1) {
      this.hangs++;
      throw new KernelTimeoutError('fillet took longer than 30 s — the geometry engine was restarted', 'fillet');
    }
    return super.fillet(shape, edges, radius);
  }
}

function filletDoc(kernel: MockKernel): Document {
  const doc = new Document(kernel);
  doc.setParameter({ name: 'r', expression: '1', unit: 'mm' });
  doc.addFeature({
    id: id('box'), type: 'box', name: 'Box', values: { dx: '10', dy: '10', dz: '10' }, inputs: {},
  });
  doc.addFeature({
    id: id('fil'), type: 'fillet', name: 'Round', values: { radius: 'r' },
    inputs: { base: id('box') }, selections: { edges: [mockTopoRef('box', 'edge', 0)] },
  });
  return doc;
}

describe('a build that timed out', () => {
  it('fails once, then fails instantly with the same message until its inputs change', async () => {
    const kernel = new HangingKernel();
    const doc = filletDoc(kernel);

    const first = await doc.recompute();
    expect(first.states.get(id('fil'))).toMatchObject({ status: 'error', fellBack: true });
    expect(kernel.hangs).toBe(1);

    // The kernel was replaced: everything is rebuilt, but the fillet is not retried.
    await doc.resetGeometry();
    const second = await doc.recompute();
    expect(second.states.get(id('fil'))!.message).toMatch(/took longer than 30 s.*try again/);
    expect(kernel.hangs).toBe(1);

    // A different radius is a different build, and this one goes through.
    doc.setParameter({ name: 'r', expression: '2', unit: 'mm' });
    const third = await doc.recompute();
    expect(third.states.get(id('fil'))).toMatchObject({ status: 'ok' });
    expect(kernel.hangs).toBe(1);
  });
});
