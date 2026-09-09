import { beforeAll, describe, expect, it } from 'vitest';
import { asFeatureId } from '@cardstock/types';
import { Document } from '@cardstock/document';
import { PlaneGcsSolver, createOcctKernel, type OcctKernel } from '@cardstock/kernel';

/**
 * A part built from SEVERAL sketches, not one.
 *
 * The failure this guards against is a model that only ever grows from the first thing
 * you drew — a second sketch that cannot become its own body, or a later feature that
 * silently attaches to the wrong one.
 */
let kernel: OcctKernel;
let solver: PlaneGcsSolver;
beforeAll(async () => {
  kernel = await createOcctKernel();
  solver = await PlaneGcsSolver.create();
}, 60_000);

const id = (s: string) => asFeatureId(s);

/** A rectangle on XY, its lower-left corner at (x, y). */
function rect(doc: Document, x: number, y: number, w: string, h: string) {
  const { sketch, id: sketchId } = doc.addSketch({ kind: 'origin', plane: 'xy' });
  const a = sketch.addPoint(x, y);
  const b = sketch.addPoint(x + 20, y + 1);
  const c = sketch.addPoint(x + 19, y + 21);
  const d = sketch.addPoint(x - 1, y + 20);
  sketch.addConstraint({ type: 'horizontal', line: sketch.addLine(a, b) });
  sketch.addConstraint({ type: 'vertical', line: sketch.addLine(b, c) });
  sketch.addConstraint({ type: 'horizontal', line: sketch.addLine(c, d) });
  sketch.addConstraint({ type: 'vertical', line: sketch.addLine(d, a) });
  sketch.addConstraint({ type: 'lockX', point: a, value: String(x) });
  sketch.addConstraint({ type: 'lockY', point: a, value: String(y) });
  sketch.addConstraint({ type: 'distance', a, b, value: w });
  sketch.addConstraint({ type: 'distance', a: b, b: c, value: h });
  return sketchId;
}

const volume = async (doc: Document, feature: string) => {
  const state = (await doc.recompute()).states.get(id(feature))!;
  if (state.status !== 'ok') throw new Error(`${feature}: ${state.status} ${state.message}`);
  return (await kernel.massProperties(state.handle!)).volume;
};

describe('a part built from several sketches', () => {
  it('extrudes two independent sketches into two separate bodies', async () => {
    const doc = new Document(kernel, undefined, solver);
    doc.setParameter({ name: 'w', expression: '30', unit: 'mm' });

    const first = rect(doc, 0, 0, 'w', '20');
    doc.addFeature({
      id: id('ex1'), type: 'extrude', name: 'Base',
      values: { distance: '10' }, inputs: { profile: first },
    });
    // A second sketch drawn later, well clear of the first.
    const second = rect(doc, 100, 0, '15', '15');
    doc.addFeature({
      id: id('ex2'), type: 'extrude', name: 'Post',
      values: { distance: '40' }, inputs: { profile: second },
    });

    const result = await doc.recompute();
    expect([...result.states.values()].every((s) => s.status === 'ok')).toBe(true);
    expect(await volume(doc, 'ex1')).toBeCloseTo(30 * 20 * 10, 3);
    expect(await volume(doc, 'ex2')).toBeCloseTo(15 * 15 * 40, 3);

    // Both are leaves: nothing consumed either, so both are on screen as bodies.
    const leaves = doc.features.filter(
      (f) => !doc.features.some((other) => Object.values(other.inputs).includes(f.id)),
    );
    expect(leaves.map((f) => f.id)).toEqual([id('ex1'), id('ex2')]);
  });

  it('joins the two into one body, and a later change still propagates', async () => {
    const doc = new Document(kernel, undefined, solver);
    doc.setParameter({ name: 'w', expression: '30', unit: 'mm' });
    const first = rect(doc, 0, 0, 'w', '20');
    doc.addFeature({
      id: id('ex1'), type: 'extrude', name: 'Base',
      values: { distance: '10' }, inputs: { profile: first },
    });
    const second = rect(doc, 10, 5, '10', '10');
    doc.addFeature({
      id: id('ex2'), type: 'extrude', name: 'Boss',
      values: { distance: '25' }, inputs: { profile: second },
    });
    doc.addFeature({
      id: id('join'), type: 'union', name: 'Joined',
      values: {}, inputs: { base: id('ex1'), tool: id('ex2') },
    });

    // Overlapping solids: the union is less than the sum.
    const joined = await volume(doc, 'join');
    expect(joined).toBeCloseTo(30 * 20 * 10 + 10 * 10 * 25 - 10 * 10 * 10, 2);

    // Change the FIRST sketch's parameter; the union has to follow.
    doc.setParameter({ name: 'w', expression: '50', unit: 'mm' });
    expect(await volume(doc, 'join'))
      .toBeCloseTo(50 * 20 * 10 + 10 * 10 * 25 - 10 * 10 * 10, 2);
  });

  it('cuts one body with another and keeps the result a single body', async () => {
    const doc = new Document(kernel, undefined, solver);
    const plate = rect(doc, 0, 0, '40', '40');
    doc.addFeature({
      id: id('ex1'), type: 'extrude', name: 'Plate',
      values: { distance: '10' }, inputs: { profile: plate },
    });
    const window = rect(doc, 10, 10, '10', '10');
    doc.addFeature({
      id: id('ex2'), type: 'extrude', name: 'Window',
      values: { distance: '30', z: '-5' }, inputs: { profile: window },
    });
    doc.addFeature({
      id: id('cut'), type: 'cut', name: 'Cut',
      values: {}, inputs: { base: id('ex1'), tool: id('ex2') },
    });
    expect(await volume(doc, 'cut')).toBeCloseTo(40 * 40 * 10 - 10 * 10 * 10, 2);
  });

  it('sketches on a face of the SECOND body, not just the first', async () => {
    const doc = new Document(kernel, undefined, solver);
    const first = rect(doc, 0, 0, '30', '30');
    doc.addFeature({
      id: id('ex1'), type: 'extrude', name: 'Base',
      values: { distance: '10' }, inputs: { profile: first },
    });
    const second = rect(doc, 100, 0, '20', '20');
    doc.addFeature({
      id: id('ex2'), type: 'extrude', name: 'Post',
      values: { distance: '30' }, inputs: { profile: second },
    });
    await doc.recompute();

    // The top face of the SECOND body.
    const handle = (await doc.recompute()).states.get(id('ex2'))!.handle!;
    const description = await kernel.describeShape(handle);
    const top = description.faces.find(
      (f) => (f.direction?.z ?? 0) > 0.99 && f.centroid.z > 29,
    )!;
    expect(top).toBeDefined();

    const { sketch, id: onFace } = doc.addSketch({
      kind: 'face',
      ref: { kind: 'face', origin: id('ex2'), index: top.index, fingerprint: top },
    }, { base: id('ex2') });
    const a = sketch.addPoint(0, 0);
    const b = sketch.addPoint(8, 0);
    const c = sketch.addPoint(8, 8);
    const d = sketch.addPoint(0, 8);
    sketch.addConstraint({ type: 'horizontal', line: sketch.addLine(a, b) });
    sketch.addConstraint({ type: 'vertical', line: sketch.addLine(b, c) });
    sketch.addConstraint({ type: 'horizontal', line: sketch.addLine(c, d) });
    sketch.addConstraint({ type: 'vertical', line: sketch.addLine(d, a) });
    sketch.addConstraint({ type: 'lockX', point: a, value: '0' });
    sketch.addConstraint({ type: 'lockY', point: a, value: '0' });
    sketch.addConstraint({ type: 'distance', a, b, value: '8' });
    sketch.addConstraint({ type: 'distance', a: b, b: c, value: '8' });

    doc.addFeature({
      id: id('ex3'), type: 'extrude', name: 'Pip',
      values: { distance: '5' }, inputs: { profile: onFace },
    });

    const result = await doc.recompute();
    expect(result.states.get(onFace)!.message ?? 'ok').toBe('ok');
    expect(result.states.get(onFace)!.status).toBe('ok');
    expect(await volume(doc, 'ex3')).toBeCloseTo(8 * 8 * 5, 3);
    // The first body is untouched by any of it.
    expect(await volume(doc, 'ex1')).toBeCloseTo(30 * 30 * 10, 3);
  });
});
