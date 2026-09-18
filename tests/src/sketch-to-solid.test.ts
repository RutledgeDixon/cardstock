import { beforeAll, describe, expect, it } from 'vitest';
import { asFeatureId } from '@cardstock/types';
import { Document, Sketch, SketchTools, constraintFromSelection } from '@cardstock/document';
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

describe('deleting and dragging', () => {
  it('removing geometry removes every constraint on it, and DOF never goes negative', async () => {
    const sketch = new Sketch({ kind: 'origin', plane: 'xy' });
    sketch.addPoint(0, 0, { fixed: true, id: 'origin' });
    const tools = new SketchTools(sketch);
    tools.setTool('rectangle');
    tools.click({ x: 0, y: 0 });
    tools.click({ x: 40, y: 25 });
    tools.setTool('line');
    tools.click({ x: 40, y: 25 });
    tools.click({ x: 60, y: 25 });
    tools.click({ x: 60, y: 0 });
    await sketch.solve(solver, {});
    expect(sketch.dof).toBeGreaterThanOrEqual(0);
    const constraintsBefore = sketch.constraints.length;
    expect(constraintsBefore).toBeGreaterThan(0);

    // Delete a rectangle side, then one of its corners, then the spur's far point.
    const side = sketch.geometry.find((e) => e.type === 'line' && !e.external)!;
    sketch.remove(side.id);
    for (const c of sketch.constraints) {
      for (const id of Object.values(c as Record<string, unknown>)) {
        if (typeof id === 'string' && id !== c.id && id !== c.type && sketch.entity(id) === undefined && /^[plcax]\d+$|^origin$/.test(id)) {
          throw new Error(`constraint ${c.id} still names deleted ${id}`);
        }
      }
    }
    await sketch.solve(solver, {});
    expect(sketch.dof).toBeGreaterThanOrEqual(0);
    expect(sketch.status).not.toBe('over-constrained');

    const corner = sketch.geometry.find((e) => e.type === 'point' && !e.fixed)!;
    sketch.remove(corner.id);
    await sketch.solve(solver, {});
    expect(sketch.dof).toBeGreaterThanOrEqual(0);
    // No line is left with a missing end.
    for (const e of sketch.geometry) {
      if (e.type === 'line') expect(sketch.entity(e.p1) && sketch.entity(e.p2)).toBeTruthy();
    }
    expect(sketch.redundant).toEqual([]);
  });

  it('a redundant constraint reads as over-constrained, never as a negative count', async () => {
    const sketch = new Sketch({ kind: 'origin', plane: 'xy' });
    sketch.addPoint(0, 0, { fixed: true, id: 'origin' });
    const a = sketch.addPoint(10, 0), b = sketch.addPoint(10, 10);
    const l1 = sketch.addLine('origin', a), l2 = sketch.addLine(a, b);
    sketch.addConstraint({ type: 'horizontal', line: l1 });
    sketch.addConstraint({ type: 'vertical', line: l2 });
    sketch.addConstraint({ type: 'perpendicular', a: l1, b: l2 }); // says nothing new
    await sketch.solve(solver, {});
    expect(sketch.status).toBe('over-constrained');
    expect(sketch.redundant.length + sketch.conflicting.length).toBeGreaterThan(0);
  });

  it('a sketch constrained in itself but not tied down drags as a whole', async () => {
    const sketch = new Sketch({ kind: 'origin', plane: 'xy' });
    sketch.addPoint(0, 0, { fixed: true, id: 'origin' });
    const a = sketch.addPoint(10, 10), b = sketch.addPoint(50, 10), c = sketch.addPoint(50, 30), d = sketch.addPoint(10, 30);
    const bottom = sketch.addLine(a, b), right = sketch.addLine(b, c), top = sketch.addLine(c, d), left = sketch.addLine(d, a);
    sketch.addConstraint({ type: 'horizontal', line: bottom });
    sketch.addConstraint({ type: 'horizontal', line: top });
    sketch.addConstraint({ type: 'vertical', line: right });
    sketch.addConstraint({ type: 'vertical', line: left });
    sketch.addConstraint({ type: 'distance', a, b, value: 40 });
    sketch.addConstraint({ type: 'distance', a: b, b: c, value: 20 });
    await sketch.solve(solver, {});
    expect(sketch.dof).toBe(2); // where it sits, and nothing else

    await sketch.solve(solver, {}, { point: a, x: 30, y: 25 });
    const p = (id: string) => sketch.entity(id) as { x: number; y: number };
    expect(p(a).x).toBeCloseTo(30, 4);
    expect(p(a).y).toBeCloseTo(25, 4);
    // The rest came along, shape intact.
    expect(p(b).x - p(a).x).toBeCloseTo(40, 4);
    expect(p(c).y - p(b).y).toBeCloseTo(20, 4);
    expect(p(d).x).toBeCloseTo(p(a).x, 4);
  });

  it('refuses to put an endpoint on its own line, or to dimension it from it', () => {
    const sketch = new Sketch({ kind: 'origin', plane: 'xy' });
    const a = sketch.addPoint(0, 0), b = sketch.addPoint(10, 0);
    const line = sketch.addLine(a, b);
    const result = constraintFromSelection(sketch, 'pointOnLine', [a, line]);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/already an end/);
  });
});

describe('arcs', () => {
  it('two clicks make a half circle on an axis, with dotted radii and a driving sweep', async () => {
    const sketch = new Sketch({ kind: 'origin', plane: 'xy' });
    sketch.addPoint(0, 0, { fixed: true, id: 'origin' });
    const tools = new SketchTools(sketch);
    tools.setTool('arc');
    // Fresh clicks, clear of the origin: a click ON a point ties the arc's end to it.
    tools.click({ x: 5, y: 5 });
    tools.click({ x: 45, y: 5 });
    const arc = sketch.geometry.find((e) => e.type === 'arc')!;
    if (arc.type !== 'arc') throw new Error('no arc');
    expect(arc.radius).toBe(20);
    expect(arc.axis).toBeDefined();
    const construction = sketch.geometry.filter((e) => e.type === 'line' && e.construction && !e.external);
    expect(construction).toHaveLength(3); // axis and two radii
    expect(sketch.constraints.find((c) => c.type === 'arcAngle')).toMatchObject({ value: 180 });

    await sketch.solve(solver, {});
    expect(sketch.status).not.toBe('over-constrained');
    // The axis ends and the centre along the bisector are the free things.
    expect(sketch.dof).toBe(5);

    // Deleting the arc takes its axis and radii; nothing dotted is left behind.
    sketch.remove(arc.id);
    expect(sketch.geometry.filter((e) => e.type === 'line' && e.construction && !e.external)).toHaveLength(0);
    expect(sketch.constraints.filter((c) => c.type === 'arcAngle')).toHaveLength(0);
  });

  it('a driven sweep keeps the centre and axis; the D-shape extrudes with the right volume', async () => {
    const doc = new Document(kernel, undefined, solver);
    const { sketch, id } = doc.addSketch({ kind: 'origin', plane: 'xy' });
    const tools = new SketchTools(sketch);
    tools.setTool('arc');
    tools.click({ x: 5, y: 5 });
    tools.click({ x: 45, y: 5 });
    const arc = sketch.geometry.find((e) => e.type === 'arc')!;
    if (arc.type !== 'arc') throw new Error('no arc');
    const centreBefore = { ...(sketch.entity(arc.centre) as { x: number; y: number }) };
    const sweep = sketch.constraints.find((c) => c.type === 'arcAngle')!;
    sketch.removeConstraint(sweep.id);
    sketch.addConstraint({ type: 'arcAngle', entity: arc.id, axis: arc.axis!, value: 90 });
    // Close the quarter arc with a real line between its ends.
    sketch.addLine(arc.end, arc.start);
    const extrude = asFeatureId('d');
    doc.addFeature({ id: extrude, type: 'extrude', name: 'D', values: { distance: '10' }, inputs: { profile: id } });
    const result = await doc.recompute();
    expect(result.states.get(id)?.message).toBeUndefined();
    expect(result.states.get(extrude)?.status).toBe('ok');
    const centreAfter = sketch.entity(arc.centre) as { x: number; y: number };
    expect(centreAfter.x).toBeCloseTo(centreBefore.x, 5);
    expect(centreAfter.y).toBeCloseTo(centreBefore.y, 5);
    const r = (sketch.entity(arc.id) as { radius: number }).radius;
    expect(r).toBeCloseTo(20, 3);
    // A circular segment of 90° of radius 20, extruded 10.
    const segment = (r * r / 2) * (Math.PI / 2 - 1);
    const volume = (await kernel.massProperties(result.states.get(extrude)!.handle!)).volume;
    expect(volume).toBeCloseTo(segment * 10, 1);
  });
});

describe('arcs on existing points', () => {
  it('ties its ends to the points it was clicked on, so the sweep moves the centre instead', async () => {
    const sketch = new Sketch({ kind: 'origin', plane: 'xy' });
    sketch.addPoint(0, 0, { fixed: true, id: 'origin' });
    const tools = new SketchTools(sketch);
    // The right end of a stadium: two line ends, 20 apart.
    tools.setTool('line');
    tools.click({ x: 10, y: 10 }); tools.click({ x: 70, y: 10 });
    tools.setTool('line');
    tools.click({ x: 70, y: 30 }); tools.click({ x: 10, y: 30 });
    tools.setTool('arc');
    tools.click({ x: 70, y: 10 }); tools.click({ x: 70, y: 30 });
    const arc = sketch.geometry.find((e) => e.type === 'arc')!;
    if (arc.type !== 'arc') throw new Error('no arc');
    const ties = sketch.constraints.filter((c) => c.type === 'coincident');
    expect(ties).toHaveLength(2);
    // Freshly drawn, nothing is redundant: the 180 is a real dimension, not a repeat.
    await sketch.solve(solver, {});
    expect(sketch.status).not.toBe('over-constrained');

    // Pin the axis ends (the line ends the arc was clicked on) so only the arc can give.
    const axisLine = sketch.entity(arc.axis!);
    if (axisLine?.type !== 'line') throw new Error('no axis');
    for (const id of [axisLine.p1, axisLine.p2]) {
      const p = sketch.entity(id) as { x: number; y: number };
      sketch.addConstraint({ type: 'lockX', point: id, value: p.x });
      sketch.addConstraint({ type: 'lockY', point: id, value: p.y });
    }
    const sweep = sketch.constraints.find((c) => c.type === 'arcAngle')!;
    sketch.removeConstraint(sweep.id);
    sketch.addConstraint({ type: 'arcAngle', entity: arc.id, axis: arc.axis!, value: 90 });
    await sketch.solve(solver, {});
    expect(sketch.status).not.toBe('over-constrained');
    const P = (id: string) => sketch.entity(id) as { x: number; y: number };
    // Ends stayed on the line ends; the centre slid along the bisector.
    expect(P(arc.start).x).toBeCloseTo(70, 4);
    expect(P(arc.start).y).toBeCloseTo(10, 4);
    expect(P(arc.end).y).toBeCloseTo(30, 4);
    expect(P(arc.centre).y).toBeCloseTo(20, 4);
    expect(P(arc.centre).x).toBeCloseTo(60, 3);
    expect((sketch.entity(arc.id) as { radius: number }).radius).toBeCloseTo(10 * Math.SQRT2, 3);
  });
});
