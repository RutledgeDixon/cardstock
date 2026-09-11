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
  it('builds an unclosed sketch as a path, and says so when it is extruded', async () => {
    // An open sketch is not a mistake — it is how a sweep path is drawn. So the sketch
    // itself succeeds, and the feature that actually needs a closed profile is the one
    // that fails, naming the real reason.
    const doc = new Document(kernel, undefined, solver);
    const { sketch, id } = doc.addSketch({ kind: 'origin', plane: 'xy' });
    const b = sketch.addPoint(20, 0);
    sketch.addLine('origin', b); // a single line encloses nothing

    let result = await doc.recompute();
    expect(result.states.get(id)!.status).toBe('ok');

    doc.addFeature({
      id: EXTRUDE, type: 'extrude', name: 'Body',
      values: { distance: '5' }, inputs: { profile: id },
    });
    result = await doc.recompute();
    expect(result.states.get(id)!.status).toBe('ok');
    expect(result.states.get(EXTRUDE)!.status).toBe('error');
    expect(result.states.get(EXTRUDE)!.message).toMatch(/open path/);
  });

  it('still refuses a sketch whose profile is ambiguous', async () => {
    // Three segments meeting at a point cannot be walked into either a loop or a path,
    // so this must stay an error rather than quietly becoming one arbitrary chain.
    const doc = new Document(kernel, undefined, solver);
    const { sketch, id } = doc.addSketch({ kind: 'origin', plane: 'xy' });
    const b = sketch.addPoint(20, 0);
    const c = sketch.addPoint(20, 10);
    const d = sketch.addPoint(20, -10);
    sketch.addLine('origin', b);
    sketch.addLine(b, c);
    sketch.addLine(b, d);

    const result = await doc.recompute();
    expect(result.states.get(id)!.status).toBe('error');
    expect(result.states.get(id)!.message).toMatch(/ambiguous/);
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

describe('several regions in one sketch', () => {
  it('two triangles sharing a corner extrude to two solids', async () => {
    const doc = new Document(kernel, undefined, solver);
    const { sketch, id } = doc.addSketch({ kind: 'origin', plane: 'xy' });
    const v = 'origin';
    const a = sketch.addPoint(-20, 10), b = sketch.addPoint(-20, -10);
    const c = sketch.addPoint(20, 10), d = sketch.addPoint(20, -10);
    sketch.addLine(v, a); sketch.addLine(a, b); sketch.addLine(b, v);
    sketch.addLine(v, c); sketch.addLine(c, d); sketch.addLine(d, v);
    const extrude = asFeatureId('bow');
    doc.addFeature({ id: extrude, type: 'extrude', name: 'Bow', values: { distance: '5' }, inputs: { profile: id } });
    const result = await doc.recompute();
    expect(result.states.get(extrude)?.status).toBe('ok');
    const handle = result.states.get(extrude)!.handle!;
    // Two triangles of 200 mm² each, 5 deep.
    expect((await kernel.massProperties(handle)).volume).toBeCloseTo(2000, 3);
    expect((await kernel.topologyCounts(handle)).faces).toBe(10);
  });
});

describe('external references', () => {
  it('a point tied to a corner of the face follows the body when it changes', async () => {
    const doc = new Document(kernel, undefined, solver);
    doc.setParameter({ name: 'width', expression: '40', unit: 'mm' });
    const base = asFeatureId('base');
    doc.addFeature({ id: base, type: 'box', name: 'Plate', values: { dx: 'width', dy: '30', dz: '5' }, inputs: {} });
    const first = await doc.recompute();
    const description = await kernel.describeShape(first.states.get(base)!.handle!);
    const top = description.faces.find((f) => (f.direction?.z ?? 0) > 0.99)!;

    const { sketch, id } = doc.addSketch({
      kind: 'face', ref: { kind: 'face', origin: base, index: top.index, fingerprint: top },
    }, { base });
    // The first rebuild brings the face's corners in as reference geometry.
    await doc.recompute();
    const corners = sketch.geometry.filter((e) => e.type === 'point' && e.external);
    expect(corners).toHaveLength(4);
    const farCorner = corners[0] as { id: string; x: number; y: number };

    const mine = sketch.addPoint(5, 5);
    sketch.addConstraint({ type: 'coincident', a: mine, b: farCorner.id });
    doc.markSketchChanged(id);
    await doc.recompute();
    const tied = sketch.entity(mine) as { x: number; y: number };
    expect(tied.x).toBeCloseTo(farCorner.x, 6);
    expect(tied.y).toBeCloseTo(farCorner.y, 6);

    // Widen the plate: the corner moves 10 mm (the face's centroid moves 10 and the far
    // corner 20 in world; the sketch frame follows the centroid) and the point with it.
    doc.setParameter({ name: 'width', expression: '60', unit: 'mm' });
    await doc.recompute();
    const movedCorner = sketch.entity(farCorner.id) as { x: number; y: number };
    const movedMine = sketch.entity(mine) as { x: number; y: number };
    expect(Math.hypot(movedCorner.x - farCorner.x, movedCorner.y - farCorner.y)).toBeCloseTo(10, 3);
    expect(movedMine.x).toBeCloseTo(movedCorner.x, 6);
    expect(movedMine.y).toBeCloseTo(movedCorner.y, 6);
  });

  it('an origin-plane sketch offers the axes, which cannot be profiled', async () => {
    const doc = new Document(kernel, undefined, solver);
    const { sketch, id } = doc.addSketch({ kind: 'origin', plane: 'xy' });
    await doc.recompute();
    const axes = sketch.geometry.filter((e) => e.type === 'line' && e.external);
    expect(axes.map((a) => a.external).sort()).toEqual(['axis:h', 'axis:v']);
    const state = (await doc.recompute()).states.get(id)!;
    // Two construction lines make no profile: the sketch is empty, not a path.
    expect(state.status).toBe('error');
    expect(state.message).toMatch(/empty/);
  });
});
