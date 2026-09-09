import { beforeAll, describe, expect, it } from 'vitest';
import { asFeatureId } from '@cardstock/types';
import { Document, captureTopoRef, type Feature, type TopoRef } from '@cardstock/document';
import { createOcctKernel, type OcctKernel } from '@cardstock/kernel';

/**
 * The Phase 4 exit criterion, against REAL OpenCascade geometry.
 *
 * Fillet an edge of a box, then change the box dimensions, insert a feature before the
 * fillet, and reorder features. The fillet must stay on the correct edge — or fail
 * loudly and repairably. It must never silently move.
 */

let kernel: OcctKernel;
beforeAll(async () => { kernel = await createOcctKernel(); }, 60_000);

const BOX = asFeatureId('box');
const FILLET = asFeatureId('fillet');

/** Build a box, then reference one specific vertical edge by fingerprint. */
async function boxWithFilletedCorner(): Promise<{ doc: Document; ref: TopoRef }> {
  const doc = new Document(kernel);
  doc.setParameter({ name: 'width', expression: '40', unit: 'mm' });
  doc.setParameter({ name: 'depth', expression: '30', unit: 'mm' });

  doc.addFeature({
    id: BOX, type: 'box', name: 'Box',
    values: { dx: 'width', dy: 'depth', dz: '20' }, inputs: {},
  });
  const first = await doc.recompute();
  const boxHandle = first.states.get(BOX)!.handle!;
  const description = await kernel.describeShape(boxHandle);

  // The vertical edge at the (max x, max y) corner — chosen geometrically, the way a
  // user picks in the viewport, not by index.
  const target = description.edges.find((e) =>
    Math.abs(e.direction!.z) > 0.99
    && e.centroidNormalised.x > 0.9
    && e.centroidNormalised.y > 0.9)!;
  expect(target).toBeDefined();

  const ref = captureTopoRef(BOX, 'edge', target.index, description)!;
  doc.addFeature({
    id: FILLET, type: 'fillet', name: 'Round',
    values: { radius: '4' }, inputs: { base: BOX }, selections: { edges: [ref] },
  });
  return { doc, ref };
}

/** Where is the filleted corner, in world coordinates? Identifies the cylindrical face. */
async function filletCornerPosition(doc: Document, handle: string): Promise<{ x: number; y: number }> {
  const description = await kernel.describeShape(handle as never);
  const round = description.faces.find((f) => f.geometryType === 'cylinder');
  expect(round, 'the fillet should have produced a cylindrical face').toBeDefined();
  return { x: round!.centroid.x, y: round!.centroid.y };
}

describe('the fillet stays on the right edge', () => {
  it('builds on the corner it was told to', async () => {
    const { doc } = await boxWithFilletedCorner();
    const result = await doc.recompute();
    expect(result.states.get(FILLET)!.status).toBe('ok');

    const corner = await filletCornerPosition(doc, result.states.get(FILLET)!.handle!);
    // The (40, 30) corner, pulled in by the 4mm radius.
    expect(corner.x).toBeGreaterThan(34);
    expect(corner.y).toBeGreaterThan(24);
  });

  it('follows the corner when the box is resized', async () => {
    // Index-based references break exactly here.
    const { doc } = await boxWithFilletedCorner();
    await doc.recompute();

    doc.setParameter({ name: 'width', expression: '75', unit: 'mm' });
    doc.setParameter({ name: 'depth', expression: '55', unit: 'mm' });
    const result = await doc.recompute();

    expect(result.states.get(FILLET)!.status).toBe('ok');
    const corner = await filletCornerPosition(doc, result.states.get(FILLET)!.handle!);
    // It must have MOVED with the corner, to roughly (75, 55) — not stayed at (40, 30),
    // and not jumped to a different corner such as (0, 55).
    expect(corner.x).toBeGreaterThan(69);
    expect(corner.y).toBeGreaterThan(49);
  });

  it('survives repeated resizes without drifting to another corner', async () => {
    const { doc } = await boxWithFilletedCorner();
    await doc.recompute();
    for (const [w, d] of [[60, 20], [25, 80], [90, 45], [40, 30]]) {
      doc.setParameter({ name: 'width', expression: String(w), unit: 'mm' });
      doc.setParameter({ name: 'depth', expression: String(d), unit: 'mm' });
      const result = await doc.recompute();
      expect(result.states.get(FILLET)!.status, `at ${w}x${d}`).toBe('ok');
      const corner = await filletCornerPosition(doc, result.states.get(FILLET)!.handle!);
      expect(corner.x, `x at ${w}x${d}`).toBeGreaterThan(w * 0.8);
      expect(corner.y, `y at ${w}x${d}`).toBeGreaterThan(d * 0.8);
    }
  });

  it('survives a feature inserted before it', async () => {
    // The fillet's input changes from a box to a box-with-a-hole. Its edge still exists,
    // but its index in the new shape is different.
    const { doc } = await boxWithFilletedCorner();
    await doc.recompute();

    const drill = asFeatureId('drill');
    const cut = asFeatureId('cut');
    doc.addFeature({
      id: drill, type: 'cylinder', name: 'Drill',
      values: { radius: '5', height: '40', x: '20', y: '15', z: '-10' }, inputs: {},
    } satisfies Feature);
    doc.addFeature({
      id: cut, type: 'cut', name: 'Hole', values: {},
      inputs: { base: BOX, tool: drill },
    } satisfies Feature);
    doc.updateFeature(FILLET, { inputs: { base: cut } });

    const result = await doc.recompute();
    expect(result.states.get(FILLET)!.status).toBe('ok');

    const description = await kernel.describeShape(result.states.get(FILLET)!.handle! as never);
    // Two cylinders now: the drilled hole and the fillet. The fillet's is the one at the
    // corner, and it must still be the (40, 30) corner.
    const round = description.faces.filter((f) => f.geometryType === 'cylinder');
    expect(round).toHaveLength(2);
    const corner = round.find((f) => f.centroid.x > 30 && f.centroid.y > 20);
    expect(corner, 'the fillet must still be on the far corner').toBeDefined();
  });
});

describe('it fails loudly rather than moving silently', () => {
  it('reports a broken reference when the edge is destroyed', async () => {
    const { doc } = await boxWithFilletedCorner();
    await doc.recompute();

    // Shrink the box so far that a 4mm fillet cannot be built on it.
    doc.setParameter({ name: 'width', expression: '3', unit: 'mm' });
    doc.setParameter({ name: 'depth', expression: '3', unit: 'mm' });
    const result = await doc.recompute();

    const fillet = result.states.get(FILLET)!;
    expect(fillet.status).toBe('error');
    expect(fillet.message).toBeTruthy();
    // Failure is local: the box itself is fine and still on screen.
    expect(result.states.get(BOX)!.status).toBe('ok');
    expect(fillet.fellBack).toBe(true);
    expect(fillet.handle).toBe(result.states.get(BOX)!.handle);
  });

  it('recovers when the offending change is undone', async () => {
    const { doc } = await boxWithFilletedCorner();
    await doc.recompute();
    doc.setParameter({ name: 'width', expression: '3', unit: 'mm' });
    expect((await doc.recompute()).states.get(FILLET)!.status).toBe('error');

    doc.undo();
    const result = await doc.recompute();
    expect(result.states.get(FILLET)!.status).toBe('ok');
  });
});

describe('references survive a save and reload', () => {
  it('rebuilds the same fillet from a serialised document', async () => {
    const { doc } = await boxWithFilletedCorner();
    const before = await doc.recompute();
    const originalCorner = await filletCornerPosition(doc, before.states.get(FILLET)!.handle!);

    const json = JSON.parse(JSON.stringify(doc.toJSON()));
    const reloaded = Document.fromJSON(json, kernel);
    const after = await reloaded.recompute();

    expect(after.states.get(FILLET)!.status).toBe('ok');
    const corner = await filletCornerPosition(reloaded, after.states.get(FILLET)!.handle!);
    expect(corner.x).toBeCloseTo(originalCorner.x, 6);
    expect(corner.y).toBeCloseTo(originalCorner.y, 6);
  });
});
