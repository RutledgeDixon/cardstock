import { beforeAll, describe, expect, it } from 'vitest';
import { asFeatureId } from '@cardstock/types';
import { Document } from '@cardstock/document';
import { PlaneGcsSolver, createOcctKernel, type OcctKernel } from '@cardstock/kernel';

/**
 * A sketch becoming a solid, through the real document, the real solver and the real
 * kernel. This is what Phase 6 is for.
 */
let kernel: OcctKernel;
let solver: PlaneGcsSolver;

beforeAll(async () => {
  kernel = await createOcctKernel();
  solver = await PlaneGcsSolver.create();
}, 60_000);

const EXTRUDE = asFeatureId('ex');

/** A parametric rectangle on XY, extruded. */
function plate(doc: Document, width: string, depth: string, height: string) {
  const { sketch, id } = doc.addSketch({ kind: 'origin', plane: 'xy' });

  const a = 'origin';                       // fixed at (0,0) by addSketch
  const b = sketch.addPoint(30, 1);
  const c = sketch.addPoint(29, 18);
  const d = sketch.addPoint(-1, 19);
  const bottom = sketch.addLine(a, b);
  const right = sketch.addLine(b, c);
  const top = sketch.addLine(c, d);
  const left = sketch.addLine(d, a);

  sketch.addConstraint({ type: 'horizontal', line: bottom });
  sketch.addConstraint({ type: 'horizontal', line: top });
  sketch.addConstraint({ type: 'vertical', line: right });
  sketch.addConstraint({ type: 'vertical', line: left });
  sketch.addConstraint({ type: 'distance', a, b, value: width });
  sketch.addConstraint({ type: 'distance', a: b, b: c, value: depth });

  doc.addFeature({
    id: EXTRUDE, type: 'extrude', name: 'Body',
    values: { distance: height }, inputs: { profile: id },
  });
  return { sketch, sketchFeature: id };
}

describe('a sketch becomes a solid', () => {
  it('solves, closes a profile, and extrudes to the right volume', async () => {
    const doc = new Document(kernel, undefined, solver);
    doc.setParameter({ name: 'width', expression: '60', unit: 'mm' });
    doc.setParameter({ name: 'depth', expression: '40', unit: 'mm' });
    doc.setParameter({ name: 'height', expression: '12', unit: 'mm' });
    const { sketch } = plate(doc, 'width', 'depth', 'height');

    const result = await doc.recompute();
    expect([...result.states.values()].map((s) => `${s.id}:${s.status}`))
      .toEqual(['sketch1:ok', 'ex:ok']);

    // Sloppy input became an exact rectangle.
    expect(sketch.dof).toBe(0);
    const solid = result.states.get(EXTRUDE)!.handle!;
    expect((await kernel.massProperties(solid)).volume).toBeCloseTo(60 * 40 * 12, 4);
    expect(await kernel.topologyCounts(solid)).toMatchObject({ faces: 6 });
  });

  it('follows a parameter change all the way through', async () => {
    // The whole promise: change a number, and the sketch, profile and solid all follow.
    const doc = new Document(kernel, undefined, solver);
    doc.setParameter({ name: 'width', expression: '60', unit: 'mm' });
    doc.setParameter({ name: 'depth', expression: '40', unit: 'mm' });
    doc.setParameter({ name: 'height', expression: '12', unit: 'mm' });
    plate(doc, 'width', 'depth', 'height');
    await doc.recompute();

    doc.setParameter({ name: 'width', expression: '85', unit: 'mm' });
    doc.setParameter({ name: 'height', expression: '5', unit: 'mm' });
    const result = await doc.recompute();

    expect(result.states.get(EXTRUDE)!.status).toBe('ok');
    const volume = (await kernel.massProperties(result.states.get(EXTRUDE)!.handle!)).volume;
    expect(volume).toBeCloseTo(85 * 40 * 5, 4);
  });

  it('cuts a hole drawn as a second loop in the same sketch', async () => {
    const doc = new Document(kernel, undefined, solver);
    doc.setParameter({ name: 'width', expression: '60', unit: 'mm' });
    doc.setParameter({ name: 'depth', expression: '40', unit: 'mm' });
    doc.setParameter({ name: 'height', expression: '10', unit: 'mm' });
    const { sketch } = plate(doc, 'width', 'depth', 'height');

    const centre = sketch.addPoint(30, 20);
    const hole = sketch.addCircle(centre, 6);
    sketch.addConstraint({ type: 'lockX', point: centre, value: 30 });
    sketch.addConstraint({ type: 'lockY', point: centre, value: 20 });
    sketch.addConstraint({ type: 'radius', entity: hole, value: 6 });

    const result = await doc.recompute();
    expect(result.states.get(EXTRUDE)!.status).toBe('ok');
    const volume = (await kernel.massProperties(result.states.get(EXTRUDE)!.handle!)).volume;
    expect(volume).toBeCloseTo((60 * 40 - Math.PI * 36) * 10, 3);
  });
});

describe('sketch failures are reported on the sketch', () => {
  it('names an unclosed profile rather than failing the extrude', async () => {
    const doc = new Document(kernel, undefined, solver);
    const { sketch, id } = doc.addSketch({ kind: 'origin', plane: 'xy' });
    const b = sketch.addPoint(20, 0);
    sketch.addLine('origin', b); // a single line encloses nothing
    doc.addFeature({
      id: EXTRUDE, type: 'extrude', name: 'Body',
      values: { distance: '5' }, inputs: { profile: id },
    });

    const result = await doc.recompute();
    const sketchState = result.states.get(id)!;
    expect(sketchState.status).toBe('error');
    expect(sketchState.message).toMatch(/does not close/);
    // The error belongs to the sketch; the extrude is merely blocked by it.
    expect(result.states.get(EXTRUDE)!.status).toBe('blocked');
  });

  it('reports an over-constrained sketch with the offending constraint ids', async () => {
    const doc = new Document(kernel, undefined, solver);
    const { sketch, id } = doc.addSketch({ kind: 'origin', plane: 'xy' });
    const b = sketch.addPoint(20, 0);
    const c = sketch.addPoint(20, 10);
    const d = sketch.addPoint(0, 10);
    sketch.addLine('origin', b); sketch.addLine(b, c);
    sketch.addLine(c, d); sketch.addLine(d, 'origin');
    sketch.addConstraint({ id: 'len20', type: 'distance', a: 'origin', b, value: 20 });
    sketch.addConstraint({ id: 'len35', type: 'distance', a: 'origin', b, value: 35 });

    doc.addFeature({
      id: EXTRUDE, type: 'extrude', name: 'Body',
      values: { distance: '5' }, inputs: { profile: id },
    });
    const state = (await doc.recompute()).states.get(id)!;
    expect(state.status).toBe('error');
    expect(state.message).toMatch(/over-constrained/);
    expect(state.message).toMatch(/len20|len35/);
  });
});

describe('persistence', () => {
  it('round-trips a sketch-driven document', async () => {
    const doc = new Document(kernel, undefined, solver);
    doc.setParameter({ name: 'width', expression: '50', unit: 'mm' });
    doc.setParameter({ name: 'depth', expression: '25', unit: 'mm' });
    doc.setParameter({ name: 'height', expression: '8', unit: 'mm' });
    plate(doc, 'width', 'depth', 'height');
    const before = await doc.recompute();
    const original = (await kernel.massProperties(before.states.get(EXTRUDE)!.handle!)).volume;
    expect(original).toBeCloseTo(50 * 25 * 8, 4);
    // Sketch geometry has to survive the file, or the profile cannot be rebuilt at all.
    const json = JSON.parse(JSON.stringify({
      ...doc.toJSON(),
      sketches: Object.fromEntries([...doc.sketches].map(([k, v]) => [k, v.toJSON()])),
    }));
    expect(Object.keys(json.sketches)).toHaveLength(1);
    expect(json.sketches.sk1.geometry.length).toBeGreaterThan(4);
    expect(json.sketches.sk1.constraints).toHaveLength(6);
  });
});
