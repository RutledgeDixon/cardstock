import { describe, expect, it } from 'vitest';
import { asFeatureId } from '@cardstock/types';
import { Document } from '../document.js';
import { MockKernel } from '../mock-kernel/mock-kernel.js';
import { MockSolver } from '../sketch/mock-solver.js';
import { bytesToBase64, base64ToBytes } from '../util/base64.js';

describe('import feature', () => {
  it('reads STEP text and STL bytes through the kernel, and is a body others can use', async () => {
    const kernel = new MockKernel();
    const doc = new Document(kernel, undefined, new MockSolver());
    const step = asFeatureId('ref');
    doc.addFeature({
      id: step, type: 'import', name: 'ref',
      values: { format: 'step', data: 'ISO-10303-21;\nHEADER;', file: 'ref.step' }, inputs: {},
    });
    const stl = asFeatureId('mesh');
    doc.addFeature({
      id: stl, type: 'import', name: 'mesh',
      values: { format: 'stl', data: bytesToBase64(new Uint8Array([1, 2, 3])) }, inputs: {},
    });
    const cut = asFeatureId('cut');
    doc.addFeature({ id: cut, type: 'cut', name: 'Cut', values: {}, inputs: { base: step, tool: stl } });

    const result = await doc.recompute();
    expect(result.states.get(step)?.status).toBe('ok');
    expect(result.states.get(stl)?.status).toBe('ok');
    expect(result.states.get(cut)?.status).toBe('ok');
    expect(kernel.calls.some((c) => c.op === 'importStep')).toBe(true);
    expect(kernel.calls.find((c) => c.op === 'importStl')?.detail).toBe('3 bytes');

    // Contents ride in the file, so a save/load round trip rebuilds the same thing.
    const copy = new Document(new MockKernel(), undefined, new MockSolver());
    copy.load(doc.toJSON());
    expect(copy.feature(step)?.values.data).toContain('ISO-10303-21');
  });

  it('fails loudly on a bad or missing payload', async () => {
    const doc = new Document(new MockKernel(), undefined, new MockSolver());
    const id = asFeatureId('bad');
    doc.addFeature({ id, type: 'import', name: 'bad', values: { format: 'step', data: 'nope' }, inputs: {} });
    const result = await doc.recompute();
    expect(result.states.get(id)?.status).toBe('error');
    expect(result.states.get(id)?.message).toMatch(/not a STEP file/);
  });
});

describe('base64', () => {
  it('round-trips large buffers without blowing the stack', () => {
    const bytes = new Uint8Array(300_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 0xff;
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });
});
