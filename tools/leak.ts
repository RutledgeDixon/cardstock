/**
 * Does repeated editing grow the WASM heap without bound?
 *
 * Every OCCT object is manually managed. The document releases the handles it CACHES,
 * but a feature that allocates intermediate shapes on the way to its result — a hole's
 * drill cylinder, a pattern's copies — hands back only the final one. Those intermediates
 * have no owner.
 */
import { asFeatureId } from '@cardstock/types';
import { Document } from '@cardstock/document';
import { PlaneGcsSolver, createOcctKernel } from '@cardstock/kernel';

const id = (s: string) => asFeatureId(s);
const kernel = await createOcctKernel();
const solver = await PlaneGcsSolver.create();

async function scrub(name: string, build: (doc: Document) => void, edits: number) {
  const doc = new Document(kernel, undefined, solver);
  build(doc);
  await doc.recompute();
  const start = kernel.registry.size;
  const marks: number[] = [];
  for (let i = 0; i < edits; i++) {
    doc.setParameter({ name: 'p', expression: String(10 + i * 0.1), unit: 'mm' });
    await doc.recompute();
    if ((i + 1) % Math.max(1, Math.floor(edits / 4)) === 0) {
      marks.push(kernel.registry.size - start);
    }
  }
  const perEdit = (kernel.registry.size - start) / edits;
  console.log(
    `${name.padEnd(28)} +${String(kernel.registry.size - start).padStart(6)} handles ` +
    `over ${edits} edits (${perEdit.toFixed(1)}/edit)  growth: ${marks.join(' → ')}`,
  );
  await doc.close?.();
}

// Long run: growth should PLATEAU at the content cache's limit, not keep climbing.
await scrub('long scrub (400 edits)', (doc) => {
  doc.setParameter({ name: 'p', expression: '10', unit: 'mm' });
  doc.addFeature({
    id: id('b'), type: 'box', name: 'B',
    values: { dx: '60', dy: '40', dz: 'p' }, inputs: {},
  });
  doc.addFeature({
    id: id('pat'), type: 'linearPattern', name: 'P',
    values: { count: '20', spacing: '15', dx: '1' }, inputs: { base: id('b') },
  });
  doc.addFeature({
    id: id('h'), type: 'hole', name: 'H',
    values: { standard: 'M4', fit: 'normal', x: '30', y: '20', z: '10', depth: '20' },
    inputs: { base: id('pat') },
  });
}, 400);

await scrub('box (no intermediates)', (doc) => {
  doc.setParameter({ name: 'p', expression: '10', unit: 'mm' });
  doc.addFeature({
    id: id('b'), type: 'box', name: 'B',
    values: { dx: 'p', dy: '10', dz: '10' }, inputs: {},
  });
}, 60);

await scrub('hole (drills a cylinder)', (doc) => {
  doc.setParameter({ name: 'p', expression: '10', unit: 'mm' });
  doc.addFeature({
    id: id('b'), type: 'box', name: 'B',
    values: { dx: '60', dy: '40', dz: 'p' }, inputs: {},
  });
  doc.addFeature({
    id: id('h'), type: 'hole', name: 'H',
    values: { standard: 'M4', fit: 'normal', x: '30', y: '20', z: '10', depth: '20' },
    inputs: { base: id('b') },
  });
}, 60);

await scrub('pattern of 20 (20 copies)', (doc) => {
  doc.setParameter({ name: 'p', expression: '10', unit: 'mm' });
  doc.addFeature({
    id: id('b'), type: 'box', name: 'B',
    values: { dx: '10', dy: '10', dz: '10' }, inputs: {},
  });
  doc.addFeature({
    id: id('pat'), type: 'linearPattern', name: 'P',
    values: { count: '20', spacing: 'p', dx: '1' }, inputs: { base: id('b') },
  });
}, 60);

await scrub('counterbored hole (2 cuts)', (doc) => {
  doc.setParameter({ name: 'p', expression: '10', unit: 'mm' });
  doc.addFeature({
    id: id('b'), type: 'box', name: 'B',
    values: { dx: '60', dy: '40', dz: 'p' }, inputs: {},
  });
  doc.addFeature({
    id: id('h'), type: 'hole', name: 'H',
    values: {
      standard: 'M4', fit: 'normal', style: 'counterbore',
      x: '30', y: '20', z: '10', depth: '20',
    },
    inputs: { base: id('b') },
  });
}, 60);
