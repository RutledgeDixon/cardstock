import { beforeAll, describe, expect, it } from 'vitest';
import { asFeatureId, type FeatureId } from '@cardstock/types';
import { Document } from '@cardstock/document';
import { PlaneGcsSolver, createOcctKernel, type OcctKernel } from '@cardstock/kernel';

/**
 * Sweep, loft and draft driven through the real document, from sketches.
 *
 * The kernel tests prove the geometry; these prove the wiring — that a sketch reaches
 * them as the right kind of shape, and that a change upstream still propagates.
 */
let kernel: OcctKernel;
let solver: PlaneGcsSolver;
beforeAll(async () => {
  kernel = await createOcctKernel();
  solver = await PlaneGcsSolver.create();
}, 60_000);

const id = (s: string) => asFeatureId(s);

/**
 * A closed square CENTRED on the sketch origin.
 *
 * Centred rather than cornered because a sweep's closed-form volume only holds when the
 * section is centred on the path it follows — an off-centre profile loses section area
 * at a mitred corner, which looks like a broken sweep but is arithmetic.
 */
function squareSketch(doc: Document, plane: 'xy' | 'xz' | 'yz', size: string) {
  const { sketch, id: sketchId } = doc.addSketch({ kind: 'origin', plane });
  const a = sketch.addPoint(-9, -11);
  const b = sketch.addPoint(11, -10);
  const c = sketch.addPoint(10, 9);
  const d = sketch.addPoint(-10, 10);
  sketch.addConstraint({ type: 'horizontal', line: sketch.addLine(a, b) });
  sketch.addConstraint({ type: 'vertical', line: sketch.addLine(b, c) });
  sketch.addConstraint({ type: 'horizontal', line: sketch.addLine(c, d) });
  sketch.addConstraint({ type: 'vertical', line: sketch.addLine(d, a) });
  sketch.addConstraint({ type: 'lockX', point: a, value: `-(${size}) / 2` });
  sketch.addConstraint({ type: 'lockY', point: a, value: `-(${size}) / 2` });
  sketch.addConstraint({ type: 'distance', a, b, value: size });
  sketch.addConstraint({ type: 'distance', a: b, b: c, value: size });
  return sketchId;
}

/** An open two-segment path, which is what an unclosed sketch builds as. */
function bentPath(doc: Document, plane: 'xy' | 'xz' | 'yz', run: string, rise: string) {
  const { sketch, id: sketchId } = doc.addSketch({ kind: 'origin', plane });
  const b = sketch.addPoint(0, 30);
  const c = sketch.addPoint(20, 30);
  const up = sketch.addLine('origin', b);
  const across = sketch.addLine(b, c);
  sketch.addConstraint({ type: 'vertical', line: up });
  sketch.addConstraint({ type: 'horizontal', line: across });
  sketch.addConstraint({ type: 'distance', a: 'origin', b, value: rise });
  sketch.addConstraint({ type: 'distance', a: b, b: c, value: run });
  return sketchId;
}

const volumeOf = async (doc: Document, feature: FeatureId) => {
  const state = (await doc.recompute()).states.get(feature)!;
  if (state.status !== 'ok') throw new Error(`${feature}: ${state.message}`);
  return (await kernel.massProperties(state.handle!)).volume;
};

describe('sweep', () => {
  it('sweeps a sketched profile along a sketched path', async () => {
    const doc = new Document(kernel, undefined, solver);
    doc.setParameter({ name: 'section', expression: '8', unit: 'mm' });
    doc.setParameter({ name: 'rise', expression: '30', unit: 'mm' });
    doc.setParameter({ name: 'run', expression: '20', unit: 'mm' });

    const profile = squareSketch(doc, 'xy', 'section');
    const path = bentPath(doc, 'xz', 'run', 'rise');
    doc.addFeature({
      id: id('sweep1'), type: 'sweep', name: 'Rail',
      values: {}, inputs: { profile, path },
    });

    // Path length times section, mitred at the corner.
    expect(await volumeOf(doc, id('sweep1'))).toBeCloseTo(8 * 8 * (30 + 20), 2);
  });

  it('follows a change to the path parameter', async () => {
    const doc = new Document(kernel, undefined, solver);
    doc.setParameter({ name: 'section', expression: '8', unit: 'mm' });
    doc.setParameter({ name: 'rise', expression: '30', unit: 'mm' });
    doc.setParameter({ name: 'run', expression: '20', unit: 'mm' });
    const profile = squareSketch(doc, 'xy', 'section');
    const path = bentPath(doc, 'xz', 'run', 'rise');
    doc.addFeature({
      id: id('sweep1'), type: 'sweep', name: 'Rail',
      values: {}, inputs: { profile, path },
    });
    await doc.recompute();

    doc.setParameter({ name: 'run', expression: '45', unit: 'mm' });
    expect(await volumeOf(doc, id('sweep1'))).toBeCloseTo(8 * 8 * (30 + 45), 2);
  });

  it('reports a sweep with no path rather than producing nothing', async () => {
    const doc = new Document(kernel, undefined, solver);
    const profile = squareSketch(doc, 'xy', '10');
    doc.addFeature({
      id: id('sweep1'), type: 'sweep', name: 'Rail',
      values: {}, inputs: { profile },
    });
    const state = (await doc.recompute()).states.get(id('sweep1'))!;
    expect(state.status).not.toBe('ok');
    expect(state.message).toMatch(/path/);
  });
});

describe('loft', () => {
  it('blends two sketched sections into a frustum', async () => {
    const doc = new Document(kernel, undefined, solver);
    doc.setParameter({ name: 'base', expression: '20', unit: 'mm' });
    doc.setParameter({ name: 'top', expression: '10', unit: 'mm' });

    const bottom = squareSketch(doc, 'xy', 'base');
    const upper = squareSketch(doc, 'xy', 'top');
    // Lift the upper section off the base plane.
    doc.addFeature({
      id: id('lift'), type: 'move', name: 'Lift',
      values: { dz: '30' }, inputs: { base: upper },
    });
    doc.addFeature({
      id: id('loft1'), type: 'loft', name: 'Taper',
      values: { ruled: '1' }, inputs: { section0: bottom, section1: id('lift') },
    });

    // Prismatoid rule, exact for a frustum: h/6 * (A1 + 4Am + A2).
    const mid = 15 * 15;
    expect(await volumeOf(doc, id('loft1')))
      .toBeCloseTo((30 / 6) * (400 + 4 * mid + 100), 1);
  });

  it('follows a change to a section parameter', async () => {
    const doc = new Document(kernel, undefined, solver);
    doc.setParameter({ name: 'base', expression: '20', unit: 'mm' });
    doc.setParameter({ name: 'top', expression: '10', unit: 'mm' });
    const bottom = squareSketch(doc, 'xy', 'base');
    const upper = squareSketch(doc, 'xy', 'top');
    doc.addFeature({
      id: id('lift'), type: 'move', name: 'Lift',
      values: { dz: '30' }, inputs: { base: upper },
    });
    doc.addFeature({
      id: id('loft1'), type: 'loft', name: 'Taper',
      values: { ruled: '1' }, inputs: { section0: bottom, section1: id('lift') },
    });
    await doc.recompute();

    doc.setParameter({ name: 'top', expression: '20', unit: 'mm' });
    // Equal sections make it a prism.
    expect(await volumeOf(doc, id('loft1'))).toBeCloseTo(20 * 20 * 30, 1);
  });

  it('reports a loft given only one section', async () => {
    const doc = new Document(kernel, undefined, solver);
    const only = squareSketch(doc, 'xy', '20');
    doc.addFeature({
      id: id('loft1'), type: 'loft', name: 'Taper',
      values: {}, inputs: { section0: only },
    });
    const state = (await doc.recompute()).states.get(id('loft1'))!;
    expect(state.status).not.toBe('ok');
    expect(state.message).toMatch(/at least two/);
  });
});

describe('draft', () => {
  it('tapers the selected side of a box and follows the angle', async () => {
    const doc = new Document(kernel, undefined, solver);
    doc.setParameter({ name: 'taper', expression: '5', unit: 'mm' });
    doc.addFeature({
      id: id('block'), type: 'box', name: 'Block',
      values: { dx: '40', dy: '40', dz: '30', x: '-20', y: '-20' }, inputs: {},
    });

    const result = await doc.recompute();
    const handle = result.states.get(id('block'))!.handle!;
    const description = await kernel.describeShape(handle);
    const sides = description.faces
      .filter((f) => Math.abs(f.direction?.z ?? 1) < 1e-6)
      .map((f) => ({
        kind: 'face' as const, origin: id('block'), index: f.index,
        fingerprint: f,
      }));
    expect(sides).toHaveLength(4);

    doc.addFeature({
      id: id('draft1'), type: 'draft', name: 'Taper',
      values: { angle: 'taper', pullZ: '1', neutralZ: '0' },
      inputs: { base: id('block') },
      selections: { faces: sides },
    });

    const tapered = await volumeOf(doc, id('draft1'));
    expect(tapered).toBeLessThan(40 * 40 * 30);

    // A bigger angle removes more: the parameter really drives the geometry.
    doc.setParameter({ name: 'taper', expression: '10', unit: 'mm' });
    expect(await volumeOf(doc, id('draft1'))).toBeLessThan(tapered);
  });

  it('reports a draft with nothing selected', async () => {
    const doc = new Document(kernel, undefined, solver);
    doc.addFeature({
      id: id('block'), type: 'box', name: 'Block',
      values: { dx: '10', dy: '10', dz: '10' }, inputs: {},
    });
    doc.addFeature({
      id: id('draft1'), type: 'draft', name: 'Taper',
      values: { angle: '5' }, inputs: { base: id('block') },
    });
    const state = (await doc.recompute()).states.get(id('draft1'))!;
    expect(state.status).toBe('error');
    expect(state.message).toMatch(/no faces selected/);
  });
});
