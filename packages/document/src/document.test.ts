import { beforeEach, describe, expect, it } from 'vitest';
import type { FeatureId } from '@cardstock/types';
import { Document } from './document.js';
import { MockKernel, mockTopoRef } from './mock-kernel/mock-kernel.js';

/**
 * The Phase 2 exit criteria, as executable assertions.
 */

let kernel: MockKernel;
let doc: Document;

/**
 * A five-feature chain with a deliberate branch:
 *
 *   width ──> box ──┐
 *                   ├──> cut ──> fillet ──> move
 *          cylinder ┘
 *
 * The cylinder does NOT depend on `width`, so editing `width` must leave it alone. That
 * branch is the whole point: a chain would pass even with a naive "rebuild everything
 * after the edit" implementation.
 */
function buildChain(d: Document) {
  d.setParameter({ name: 'width', expression: '40', unit: 'mm' });
  d.setParameter({ name: 'holeRadius', expression: '6', unit: 'mm' });

  const box = d.addFeature({
    id: 'box' as FeatureId, type: 'box', name: 'Base',
    values: { dx: 'width', dy: '30', dz: '20' }, inputs: {},
  });
  const cyl = d.addFeature({
    id: 'cyl' as FeatureId, type: 'cylinder', name: 'Drill',
    values: { radius: 'holeRadius', height: '40' }, inputs: {},
  });
  const cut = d.addFeature({
    id: 'cut' as FeatureId, type: 'cut', name: 'Hole',
    values: {}, inputs: { base: box.id, tool: cyl.id },
  });
  const fillet = d.addFeature({
    id: 'fillet' as FeatureId, type: 'fillet', name: 'Round',
    values: { radius: '4' }, inputs: { base: cut.id }, selections: { edges: [mockTopoRef('cut', 'edge', 0), mockTopoRef('cut', 'edge', 1)] },
  });
  const move = d.addFeature({
    id: 'move' as FeatureId, type: 'move', name: 'Position',
    values: { dx: '10', dy: '0', dz: '0' }, inputs: { base: fillet.id },
  });
  return { box, cyl, cut, fillet, move };
}

beforeEach(() => {
  kernel = new MockKernel();
  doc = new Document(kernel);
});

describe('exit criterion: only the dirty branch rebuilds, in dependency order', () => {
  it('builds everything on the first run, dependencies first', async () => {
    buildChain(doc);
    const result = await doc.recompute();

    expect(result.order).toEqual(['box', 'cyl', 'cut', 'fillet', 'move']);
    expect(result.computed).toEqual(['box', 'cyl', 'cut', 'fillet', 'move']);
    expect([...result.states.values()].every((s) => s.status === 'ok')).toBe(true);
    // 40*30*20 = 24000, minus a pi*6^2*40 cylinder, minus the mock's fillet sliver.
    const move = result.states.get('move' as FeatureId)!;
    expect(kernel.volumeOf(move.handle!)).toBeCloseTo(24000 - Math.PI * 36 * 40 - 32, 6);
  });

  it('rebuilds exactly the affected subset when a parameter changes', async () => {
    buildChain(doc);
    await doc.recompute();
    kernel.calls.length = 0;

    doc.setParameter({ name: 'width', expression: '55', unit: 'mm' });
    const result = await doc.recompute();

    // The cylinder branch is untouched; everything downstream of the box is not.
    expect(result.order).toEqual(['box', 'cut', 'fillet', 'move']);
    expect(result.skipped).toEqual(['cyl']);
    expect(kernel.callsTo('makeCylinder')).toBe(0);
    expect(kernel.callsTo('makeBox')).toBe(1);
  });

  it('rebuilds only the cylinder branch when its own parameter changes', async () => {
    buildChain(doc);
    await doc.recompute();
    kernel.calls.length = 0;

    doc.setParameter({ name: 'holeRadius', expression: '8', unit: 'mm' });
    const result = await doc.recompute();

    expect(result.order).toEqual(['cyl', 'cut', 'fillet', 'move']);
    expect(result.skipped).toEqual(['box']);
    expect(kernel.callsTo('makeBox')).toBe(0);
  });

  it('touches nothing when an unrelated parameter changes', async () => {
    buildChain(doc);
    doc.setParameter({ name: 'unused', expression: '99', unit: 'mm' });
    await doc.recompute();
    kernel.calls.length = 0;

    doc.setParameter({ name: 'unused', expression: '123', unit: 'mm' });
    const result = await doc.recompute();

    expect(result.order).toEqual([]);
    expect(kernel.calls).toEqual([]);
  });

  it('rebuilds only downstream of an edited feature', async () => {
    const { fillet } = buildChain(doc);
    await doc.recompute();
    kernel.calls.length = 0;

    doc.updateFeature(fillet.id, { values: { radius: '2' } });
    const result = await doc.recompute();

    expect(result.order).toEqual(['fillet', 'move']);
    expect(result.skipped.sort()).toEqual(['box', 'cut', 'cyl']);
  });
});

describe('content-addressed cache', () => {
  it('serves a reverted value from cache instead of the kernel', async () => {
    buildChain(doc);
    await doc.recompute();

    doc.setParameter({ name: 'width', expression: '55', unit: 'mm' });
    await doc.recompute();
    kernel.calls.length = 0;

    doc.setParameter({ name: 'width', expression: '40', unit: 'mm' }); // back to the start
    const result = await doc.recompute();

    // Scrubbing a slider back and forth must not re-run geometry.
    expect(result.reused).toEqual(['box', 'cut', 'fillet', 'move']);
    expect(result.computed).toEqual([]);
    expect(kernel.calls).toEqual([]);
  });

  it('keys on content, so two features with identical inputs share one result', async () => {
    doc.addFeature({ id: 'a' as FeatureId, type: 'box', name: 'A', values: { dx: '10', dy: '10', dz: '10' }, inputs: {} });
    doc.addFeature({ id: 'b' as FeatureId, type: 'box', name: 'B', values: { dx: '10', dy: '10', dz: '10' }, inputs: {} });
    const result = await doc.recompute();

    expect(kernel.callsTo('makeBox')).toBe(1);
    expect(result.states.get('b' as FeatureId)!.cached).toBe(true);
    expect(result.states.get('a' as FeatureId)!.handle)
      .toBe(result.states.get('b' as FeatureId)!.handle);
  });
});

describe('failure is local', () => {
  it('falls back to the input shape and keeps building downstream', async () => {
    buildChain(doc);
    await doc.recompute();

    // A fillet radius the kernel rejects.
    doc.updateFeature('fillet' as FeatureId, { values: { radius: '-1' } });
    const result = await doc.recompute();

    const fillet = result.states.get('fillet' as FeatureId)!;
    const cut = result.states.get('cut' as FeatureId)!;
    const move = result.states.get('move' as FeatureId)!;

    expect(fillet.status).toBe('error');
    expect(fillet.message).toMatch(/radius must be positive/);
    expect(fillet.fellBack).toBe(true);
    expect(fillet.handle).toBe(cut.handle); // the un-filleted solid flows on
    expect(move.status).toBe('ok'); // downstream still built
  });

  it('blocks downstream when a root feature fails, since there is nothing to fall back to', async () => {
    buildChain(doc);
    kernel.failOn('makeBox');
    const result = await doc.recompute();

    expect(result.states.get('box' as FeatureId)!.status).toBe('error');
    expect(result.states.get('box' as FeatureId)!.handle).toBeNull();
    expect(result.states.get('cut' as FeatureId)!.status).toBe('blocked');
    // The cylinder is on an independent branch and must still be fine.
    expect(result.states.get('cyl' as FeatureId)!.status).toBe('ok');
  });

  it('reports a bad expression against the feature, not the whole document', async () => {
    buildChain(doc);
    doc.updateFeature('fillet' as FeatureId, { values: { radius: 'nonsense * 2' } });
    const result = await doc.recompute();

    const fillet = result.states.get('fillet' as FeatureId)!;
    expect(fillet.status).toBe('error');
    expect(fillet.message).toMatch(/radius: unknown parameter "nonsense"/);
    expect(result.states.get('move' as FeatureId)!.status).toBe('ok');
  });

  it('suppressing a feature passes its input straight through', async () => {
    buildChain(doc);
    await doc.recompute();
    doc.setSuppressed('fillet' as FeatureId, true);
    const result = await doc.recompute();

    const fillet = result.states.get('fillet' as FeatureId)!;
    expect(fillet.status).toBe('suppressed');
    expect(fillet.handle).toBe(result.states.get('cut' as FeatureId)!.handle);
    expect(result.states.get('move' as FeatureId)!.status).toBe('ok');
  });
});

describe('undo and redo', () => {
  it('round-trips a parameter edit', async () => {
    buildChain(doc);
    await doc.recompute();
    const before = doc.parameters.value('width');

    doc.setParameter({ name: 'width', expression: '99', unit: 'mm' });
    expect(doc.parameters.value('width')).toBe(99);

    expect(doc.undo()).toBe(true);
    expect(doc.parameters.value('width')).toBe(before);
    expect(doc.redo()).toBe(true);
    expect(doc.parameters.value('width')).toBe(99);
  });

  it('round-trips structural edits', () => {
    buildChain(doc);
    const count = doc.features.length;
    doc.removeFeature('fillet' as FeatureId);
    expect(doc.features.length).toBe(count - 1);
    doc.undo();
    expect(doc.features.length).toBe(count);
    expect(doc.feature('fillet' as FeatureId)).toBeDefined();
  });

  it('restores geometry from cache after undo, without re-running the kernel', async () => {
    buildChain(doc);
    await doc.recompute();
    doc.setParameter({ name: 'width', expression: '55', unit: 'mm' });
    await doc.recompute();
    kernel.calls.length = 0;

    doc.undo();
    const result = await doc.recompute();

    expect(result.computed).toEqual([]);
    expect(kernel.calls).toEqual([]);
  });

  it('reports what undo and redo would do', () => {
    doc.setParameter({ name: 'w', expression: '1', unit: 'mm' }, { label: 'Set w' });
    expect(doc.undoLabel).toBe('Set w');
    expect(doc.canRedo).toBe(false);
    doc.undo();
    expect(doc.redoLabel).toBe('Set w');
  });

  it('does nothing when there is nothing to undo', () => {
    expect(doc.undo()).toBe(false);
    expect(doc.redo()).toBe(false);
  });
});

describe('save and load', () => {
  it('round-trips a document and rebuilds to identical geometry', async () => {
    buildChain(doc);
    const first = await doc.recompute();
    const originalVolume = kernel.volumeOf(first.states.get('move' as FeatureId)!.handle!);

    const json = JSON.parse(JSON.stringify(doc.toJSON()));

    const kernel2 = new MockKernel();
    const reloaded = Document.fromJSON(json, kernel2);
    const second = await reloaded.recompute();

    expect(second.order).toEqual(first.order);
    expect([...second.states.values()].every((s) => s.status === 'ok')).toBe(true);
    expect(kernel2.volumeOf(second.states.get('move' as FeatureId)!.handle!))
      .toBeCloseTo(originalVolume!, 9);
  });

  it('stores no geometry — files stay small and diffable', () => {
    buildChain(doc);
    const text = JSON.stringify(doc.toJSON());
    expect(text).not.toMatch(/mock-/); // no shape handles
    expect(text.length).toBeLessThan(2000);
  });

  it('does not reuse an id already present in the loaded file', () => {
    doc.addFeature({ id: 'f7' as FeatureId, type: 'box', name: '', values: {}, inputs: {} });
    const reloaded = Document.fromJSON(JSON.parse(JSON.stringify(doc.toJSON())), new MockKernel());
    expect(reloaded.newFeatureId()).not.toBe('f7');
  });
});

describe('cancellation', () => {
  it('abandons an in-flight rebuild when a newer edit arrives', async () => {
    buildChain(doc);
    await doc.recompute();

    kernel.latencyMs = 5;
    doc.setParameter({ name: 'width', expression: '50', unit: 'mm' });
    const slow = doc.recompute();
    doc.setParameter({ name: 'width', expression: '60', unit: 'mm' });
    const fast = doc.recompute();

    const [slowResult, fastResult] = await Promise.all([slow, fast]);
    expect(slowResult.cancelled).toBe(true);
    expect(fastResult.cancelled).toBe(false);
    // The surviving run reflects the newest value.
    expect(doc.parameters.value('width')).toBe(60);
  });
});

describe('cache eviction', () => {
  it('bounds the cache while keeping live geometry', async () => {
    buildChain(doc);
    doc.cacheLimit = 8;
    // Visit many distinct values, as a slider drag would.
    for (let w = 1; w <= 60; w++) {
      doc.setParameter({ name: 'width', expression: String(w), unit: 'mm' });
      await doc.recompute();
    }
    expect(doc.engine.cacheSize).toBeLessThanOrEqual(8 + 5);
    expect(kernel.released.length).toBeGreaterThan(0);

    // Whatever is on screen right now must still be valid.
    const result = await doc.recompute();
    for (const state of result.states.values()) {
      if (state.handle) expect(kernel.shape(state.handle)).toBeDefined();
    }
  });

  it('never releases a shape the current model is using', async () => {
    buildChain(doc);
    doc.cacheLimit = 0;
    const result = await doc.recompute();
    const live = [...result.states.values()].map((s) => s.handle).filter(Boolean);
    for (const handle of live) {
      expect(kernel.released).not.toContain(handle);
    }
  });
});

describe('files carry sketches', () => {
  it('round-trips a sketch through toJSON and load', () => {
    const doc = new Document(new MockKernel());
    const { sketch, id } = doc.addSketch({ kind: 'origin', plane: 'xy' });
    const b = sketch.addPoint(20, 0);
    const line = sketch.addLine('origin', b);
    sketch.addConstraint({ type: 'horizontal', line });

    const json = JSON.parse(JSON.stringify(doc.toJSON()));
    expect(Object.keys(json.sketches)).toHaveLength(1);

    const reopened = new Document(new MockKernel());
    reopened.load(json);
    const restored = reopened.sketchFor(id);
    expect(restored).not.toBeNull();
    expect(restored!.geometry.filter((e) => e.type === 'line')).toHaveLength(1);
    expect(restored!.constraints).toHaveLength(1);
  });

  it('loads in place, so a held reference sees the new contents', () => {
    const doc = new Document(new MockKernel());
    doc.addFeature({ id: 'a' as FeatureId, type: 'box', name: 'A', values: {}, inputs: {} });
    const held = doc;
    doc.load({
      schemaVersion: 2, meta: { name: 'Loaded' }, parameters: [], sketches: {},
      features: [{ id: 'z', type: 'box', name: 'Z', values: {}, inputs: {} }],
    });
    expect(held.features.map((f) => f.id)).toEqual(['z']);
    expect(held.meta.name).toBe('Loaded');
    expect(held.canUndo).toBe(false);
  });

  it('keeps new ids clear of a loaded file, sketches included', () => {
    const doc = new Document(new MockKernel());
    doc.load({
      schemaVersion: 2, meta: {}, parameters: [],
      features: [{ id: 'sketch7', type: 'sketch', name: 'S', values: {}, inputs: {}, sketchId: 'sk7' }],
      sketches: { sk7: { plane: { kind: 'origin', plane: 'xy' }, geometry: [], constraints: [] } },
    });
    const { id } = doc.addSketch({ kind: 'origin', plane: 'xy' });
    expect(id).not.toBe('sketch7');
    expect(doc.feature(id)?.sketchId).not.toBe('sk7');
  });

  it('reports every edit through subscribe, after the edit has landed', async () => {
    const doc = new Document(new MockKernel());
    const seen: number[] = [];
    doc.subscribe((revision) => seen.push(revision));
    const before = doc.revision;
    doc.setParameter({ name: 'w', expression: '1', unit: 'mm' });
    doc.addFeature({ id: 'a' as FeatureId, type: 'box', name: 'A', values: {}, inputs: {} });
    await Promise.resolve();
    expect(seen.length).toBe(2);
    expect(doc.revision).toBe(before + 2);
  });
});
