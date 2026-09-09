import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { asFeatureId } from '@cardstock/types';
import { Document, captureTopoRef, type Feature } from '@cardstock/document';
import { createOcctKernel } from '@cardstock/kernel';
import { CORPUS_DIR, type Expectation } from './corpus.js';

/**
 * Regenerate the regression corpus.
 *
 * Run with `npm run corpus` after a DELIBERATE geometry change, and read the diff: an
 * expectation that moves without an intended cause is the bug this corpus exists to
 * catch.
 */
const kernel = await createOcctKernel();

async function emit(name: string, description: string, build: (doc: Document) => Promise<void>) {
  const doc = new Document(kernel);
  await build(doc);
  const result = await doc.recompute();

  const terminal = [...result.states.values()].at(-1)!;
  const counts = await kernel.topologyCounts(terminal.handle!);
  const mass = await kernel.massProperties(terminal.handle!);

  const expected: Expectation = {
    name,
    description,
    volume: Number(mass.volume.toFixed(4)),
    faces: counts.faces,
    edges: counts.edges,
    vertices: counts.vertices,
    ok: [...result.states.values()].filter((s) => s.status === 'ok').map((s) => s.id),
  };

  writeFileSync(join(CORPUS_DIR, `${name}.card`), JSON.stringify(doc.toJSON(), null, 2) + '\n');
  writeFileSync(join(CORPUS_DIR, `${name}.expected.json`), JSON.stringify(expected, null, 2) + '\n');
   
  console.log(`  ${name}: vol ${expected.volume}  f${expected.faces} e${expected.edges} v${expected.vertices}`);
}

// --- 1. the simplest thing that can regress
await emit('plate', 'A parametric plate. Nothing to name; the control case.', async (doc) => {
  doc.setParameter({ name: 'width', expression: '60', unit: 'mm' });
  doc.addFeature({
    id: asFeatureId('plate'), type: 'box', name: 'Plate',
    values: { dx: 'width', dy: '40', dz: '12' }, inputs: {},
  });
});

// --- 2. a reference that must survive its own feature rebuilding
await emit('filleted-corner', 'A fillet on a chosen corner, driven by parameters.', async (doc) => {
  doc.setParameter({ name: 'width', expression: '50', unit: 'mm' });
  doc.setParameter({ name: 'radius', expression: '6', unit: 'mm' });
  const box = asFeatureId('box');
  doc.addFeature({
    id: box, type: 'box', name: 'Box',
    values: { dx: 'width', dy: '35', dz: '20' }, inputs: {},
  });
  const first = await doc.recompute();
  const description = await kernel.describeShape(first.states.get(box)!.handle!);
  const corner = description.edges.find((e) =>
    Math.abs(e.direction!.z) > 0.99 && e.centroidNormalised.x > 0.9 && e.centroidNormalised.y > 0.9)!;
  doc.addFeature({
    id: asFeatureId('round'), type: 'fillet', name: 'Round',
    values: { radius: 'radius' }, inputs: { base: box },
    selections: { edges: [captureTopoRef(box, 'edge', corner.index, description)!] },
  } satisfies Feature);
});

// --- 3. a reference that must survive an operation inserted beneath it
await emit('fillet-over-hole', 'A fillet referencing a box edge, resolved through a cut.', async (doc) => {
  doc.setParameter({ name: 'width', expression: '60', unit: 'mm' });
  const box = asFeatureId('box');
  doc.addFeature({
    id: box, type: 'box', name: 'Box',
    values: { dx: 'width', dy: '40', dz: '18' }, inputs: {},
  });
  const first = await doc.recompute();
  const description = await kernel.describeShape(first.states.get(box)!.handle!);
  const corner = description.edges.find((e) =>
    Math.abs(e.direction!.z) > 0.99 && e.centroidNormalised.x > 0.9 && e.centroidNormalised.y > 0.9)!;
  const ref = captureTopoRef(box, 'edge', corner.index, description)!;

  const drill = asFeatureId('drill');
  const cut = asFeatureId('cut');
  doc.addFeature({
    id: drill, type: 'cylinder', name: 'Drill',
    values: { radius: '7', height: '40', x: '30', y: '20', z: '-10' }, inputs: {},
  });
  doc.addFeature({ id: cut, type: 'cut', name: 'Hole', values: {}, inputs: { base: box, tool: drill } });
  doc.addFeature({
    id: asFeatureId('round'), type: 'fillet', name: 'Round',
    values: { radius: '5' }, inputs: { base: cut }, selections: { edges: [ref] },
  } satisfies Feature);
});

 
console.log('corpus written to fixtures/');
