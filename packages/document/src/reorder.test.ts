import { beforeEach, describe, expect, it } from 'vitest';
import type { FeatureId } from '@cardstock/types';
import { Document } from './document.js';
import { MockKernel } from './mock-kernel/mock-kernel.js';

/**
 * Reorder rewires the primary-input chain, so dragging a feature does what a SolidWorks
 * user expects — but as an explicit, undoable, refusable edit rather than a side effect
 * of an array index.
 */

let kernel: MockKernel;
let doc: Document;

/** Box -> Cut(hole) -> Fillet, a plain chain. */
function chain(d: Document) {
  d.addFeature({ id: 'box' as FeatureId, type: 'box', name: 'Box', values: { dx: '40', dy: '30', dz: '20' }, inputs: {} });
  d.addFeature({ id: 'cyl' as FeatureId, type: 'cylinder', name: 'Drill', values: { radius: '6', height: '40' }, inputs: {} });
  d.addFeature({ id: 'cut' as FeatureId, type: 'cut', name: 'Hole', values: {}, inputs: { base: 'box' as FeatureId, tool: 'cyl' as FeatureId } });
  d.addFeature({ id: 'fil' as FeatureId, type: 'fillet', name: 'Round', values: { radius: '3' }, inputs: { base: 'cut' as FeatureId }, selections: { edges: [0] } });
}

const inputsOf = (d: Document, id: string) => d.feature(id as FeatureId)!.inputs;
const order = (d: Document) => d.features.map((f) => f.id);

beforeEach(() => {
  kernel = new MockKernel();
  doc = new Document(kernel);
  chain(doc);
});

describe('rewiring', () => {
  it('re-points the chain when a feature is dragged above its input', () => {
    // Box, Drill, Hole, Round  ->  drag Round above Hole.
    const result = doc.moveFeature('fil' as FeatureId, 2);

    expect(result.ok).toBe(true);
    expect(order(doc)).toEqual(['box', 'cyl', 'fil', 'cut']);
    // The fillet now works on the plain box; the cut now works on the filleted box.
    expect(inputsOf(doc, 'fil').base).toBe('box');
    expect(inputsOf(doc, 'cut').base).toBe('fil');
  });

  it('leaves secondary inputs alone', () => {
    // "Which solid does this cut with" is not something a drag can express.
    doc.moveFeature('fil' as FeatureId, 2);
    expect(inputsOf(doc, 'cut').tool).toBe('cyl');
  });

  it('reports exactly what it rebound, so the UI can explain it', () => {
    const result = doc.moveFeature('fil' as FeatureId, 2);
    const summary = result.rewired.map((r) => `${r.id}.${r.role}: ${r.from}->${r.to}`).sort();
    expect(summary).toEqual(['cut.base: box->fil', 'fil.base: cut->box']);
  });

  it('closes the gap when a feature moves out of the middle', () => {
    // Move the cut to the end: the fillet must bypass it rather than dangle.
    const result = doc.moveFeature('cut' as FeatureId, 3);
    expect(result.ok).toBe(true);
    expect(inputsOf(doc, 'fil').base).toBe('box');
    expect(inputsOf(doc, 'cut').base).toBe('fil');
  });

  it('produces different geometry, because it is a real edit', async () => {
    const before = await doc.recompute();
    const beforeVolume = kernel.volumeOf(before.states.get('cut' as FeatureId)!.handle!);

    doc.moveFeature('fil' as FeatureId, 2);
    const after = await doc.recompute();
    const afterVolume = kernel.volumeOf(after.states.get('cut' as FeatureId)!.handle!);

    // Filleting before drilling vs after gives a different result in the mock's
    // arithmetic, which is the point: the drag changed the model.
    expect(afterVolume).not.toBeCloseTo(beforeVolume!, 6);
  });
});

describe('refusals are loud and explain themselves', () => {
  it('refuses to show a feature above something it depends on', () => {
    // Dragging the box to the bottom would leave the cut - which consumes it - above it.
    // The graph would still build correctly, but the tree would read backwards.
    const result = doc.moveFeature('box' as FeatureId, 3);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/would sit above "Box", which it depends on/);
  });

  it('refuses to leave a dependent feature with nothing to operate on', () => {
    const result = doc.moveFeature('fil' as FeatureId, 0);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/needs something above it/);
    expect(order(doc)).toEqual(['box', 'cyl', 'cut', 'fil']); // unchanged
  });

  it('handles dragging a feature below its own consumer by re-linking the chain', () => {
    doc.addFeature({
      id: 'move' as FeatureId, type: 'move', name: 'Shift',
      values: { dx: '5' }, inputs: { base: 'fil' as FeatureId },
    });
    // Box -> Hole -> Round -> Shift; drag Round below Shift.
    const result = doc.moveFeature('fil' as FeatureId, 4);

    // This is a legal splice, not a refusal: Shift bypasses Round, Round takes Shift.
    expect(result.ok).toBe(true);
    expect(order(doc)).toEqual(['box', 'cyl', 'cut', 'move', 'fil']);
    expect(inputsOf(doc, 'move').base).toBe('cut');
    expect(inputsOf(doc, 'fil').base).toBe('move');
  });

  it('changes nothing at all when refused', () => {
    const before = JSON.stringify(doc.toJSON());
    doc.moveFeature('fil' as FeatureId, 0);
    expect(JSON.stringify(doc.toJSON())).toBe(before);
  });
});

describe('root features move freely', () => {
  it('reorders a primitive without rewiring anything', () => {
    const result = doc.moveFeature('cyl' as FeatureId, 0);
    expect(result.ok).toBe(true);
    expect(result.rewired).toEqual([]);
    expect(order(doc)).toEqual(['cyl', 'box', 'cut', 'fil']);
    expect(inputsOf(doc, 'cut').base).toBe('box'); // untouched
  });
});

describe('undo', () => {
  it('undoes a reorder and its rewiring as one step', () => {
    doc.moveFeature('fil' as FeatureId, 2);
    expect(inputsOf(doc, 'fil').base).toBe('box');

    expect(doc.undo()).toBe(true);
    expect(order(doc)).toEqual(['box', 'cyl', 'cut', 'fil']);
    expect(inputsOf(doc, 'fil').base).toBe('cut');
    expect(inputsOf(doc, 'cut').base).toBe('box');
  });

  it('redoes it', () => {
    doc.moveFeature('fil' as FeatureId, 2);
    doc.undo();
    doc.redo();
    expect(inputsOf(doc, 'fil').base).toBe('box');
    expect(inputsOf(doc, 'cut').base).toBe('fil');
  });
});

describe('rebuild after reorder', () => {
  it('marks the rewired features dirty and rebuilds them', async () => {
    await doc.recompute();
    kernel.calls.length = 0;

    doc.moveFeature('fil' as FeatureId, 2);
    const result = await doc.recompute();

    // Both ends of the splice changed inputs, so both must rebuild.
    expect(result.order).toContain('fil');
    expect(result.order).toContain('cut');
    expect([...result.states.values()].every((s) => s.status === 'ok')).toBe(true);
  });
});
