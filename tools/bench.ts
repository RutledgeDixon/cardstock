/**
 * Performance harness.
 *
 * Answers one question: at what size does this stop feeling instant? Every case is
 * shaped like something you would actually model for a printer — a plate with a bolt
 * pattern, a bracket with fillets — rather than a synthetic graph, because the costs
 * that matter are the ones a real part incurs.
 *
 * Run with: npx tsx tools/bench.ts
 */
import { asFeatureId, type FeatureId } from '@cardstock/types';
import { Document } from '@cardstock/document';
import { PlaneGcsSolver, createOcctKernel, type OcctKernel } from '@cardstock/kernel';

const id = (s: string) => asFeatureId(s);
const ms = (n: number) => `${n.toFixed(0)}ms`;

let kernel: OcctKernel;
let solver: PlaneGcsSolver;

async function time<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const at = performance.now();
  const value = await fn();
  return [value, performance.now() - at];
}

interface Row {
  case: string;
  size: string;
  build: number;
  edit: number;
  tessellate: number;
  triangles: number;
  computed: number;
  reused: number;
  handles: number;
}
const rows: Row[] = [];

/** Build, then change one root parameter and rebuild — the thing the whole app is for. */
async function measure(
  name: string, size: string,
  make: (doc: Document) => FeatureId,
  edit: (doc: Document) => void,
): Promise<void> {
  const doc = new Document(kernel, undefined, solver);
  const terminal = make(doc);

  const [, build] = await time(() => doc.recompute());
  const [result, editMs] = await time(async () => { edit(doc); return doc.recompute(); });

  const state = result.states.get(terminal);
  if (!state?.handle) {
    rows.push({
      case: name, size, build, edit: editMs, tessellate: 0, triangles: 0,
      computed: result.computed.length, reused: result.reused.length,
      handles: kernel.registry.size,
    });
    console.log(`  ${name} (${size}): FAILED — ${state?.status} ${state?.message ?? ''}`);
    return;
  }

  const [mesh, tessellate] = await time(
    () => kernel.tessellate(state.handle!, 'bench' as never, {
      linearDeflection: 0.1, angularDeflection: 0.35,
    }),
  );

  rows.push({
    case: name, size, build, edit: editMs, tessellate,
    triangles: mesh.indices.length / 3,
    computed: result.computed.length, reused: result.reused.length,
    handles: kernel.registry.size,
  });
}

/** A rectangle sketch, fully constrained, driven by a named parameter. */
function plateSketch(doc: Document, w: string, h: string): FeatureId {
  const { sketch, id: sk } = doc.addSketch({ kind: 'origin', plane: 'xy' });
  const a = sketch.addPoint(0, 0);
  const b = sketch.addPoint(59, 1);
  const c = sketch.addPoint(60, 40);
  const d = sketch.addPoint(-1, 39);
  sketch.addConstraint({ type: 'horizontal', line: sketch.addLine(a, b) });
  sketch.addConstraint({ type: 'vertical', line: sketch.addLine(b, c) });
  sketch.addConstraint({ type: 'horizontal', line: sketch.addLine(c, d) });
  sketch.addConstraint({ type: 'vertical', line: sketch.addLine(d, a) });
  sketch.addConstraint({ type: 'lockX', point: a, value: '0' });
  sketch.addConstraint({ type: 'lockY', point: a, value: '0' });
  sketch.addConstraint({ type: 'distance', a, b, value: w });
  sketch.addConstraint({ type: 'distance', a: b, b: c, value: h });
  return sk;
}

async function main(): Promise<void> {
  console.log('booting kernel and solver…');
  const [, boot] = await time(async () => {
    kernel = await createOcctKernel();
    solver = await PlaneGcsSolver.create();
  });
  console.log(`  booted in ${ms(boot)}\n`);

  // --- a plate with N holes: the commonest thing anyone models for a printer
  for (const holes of [4, 16, 64, 144]) {
    const side = Math.round(Math.sqrt(holes));
    await measure('plate + hole grid', `${holes} holes`, (doc) => {
      doc.setParameter({ name: 'w', expression: '120', unit: 'mm' });
      const sk = plateSketch(doc, 'w', '120');
      doc.addFeature({
        id: id('plate'), type: 'extrude', name: 'Plate',
        values: { distance: '8' }, inputs: { profile: sk },
      });
      let previous = id('plate');
      for (let i = 0; i < holes; i++) {
        const next = id(`h${i}`);
        doc.addFeature({
          id: next, type: 'hole', name: `Hole ${i}`,
          values: {
            standard: 'M3', fit: 'normal',
            x: String(8 + (i % side) * (104 / Math.max(1, side - 1))),
            y: String(8 + Math.floor(i / side) * (104 / Math.max(1, side - 1))),
            z: '8', depth: '10',
          },
          inputs: { base: previous },
        });
        previous = next;
      }
      return previous;
    }, (doc) => doc.setParameter({ name: 'w', expression: '130', unit: 'mm' }));
  }

  // --- a deep chain of fillets: every feature depends on the last
  for (const depth of [5, 15, 30]) {
    await measure('chained fillets', `${depth} deep`, (doc) => {
      doc.setParameter({ name: 'size', expression: '60', unit: 'mm' });
      doc.addFeature({
        id: id('box'), type: 'box', name: 'Box',
        values: { dx: 'size', dy: '40', dz: '30' }, inputs: {},
      });
      let previous = id('box');
      for (let i = 0; i < depth; i++) {
        const next = id(`m${i}`);
        doc.addFeature({
          id: next, type: 'move', name: `Move ${i}`,
          values: { dx: '0', dy: '0', dz: '0' }, inputs: { base: previous },
        });
        previous = next;
      }
      return previous;
    }, (doc) => doc.setParameter({ name: 'size', expression: '70', unit: 'mm' }));
  }

  // --- many independent bodies, the way a plate of parts looks
  for (const count of [10, 40, 100]) {
    await measure('independent bodies', `${count} bodies`, (doc) => {
      doc.setParameter({ name: 'size', expression: '10', unit: 'mm' });
      let last = id('b0');
      for (let i = 0; i < count; i++) {
        last = id(`b${i}`);
        doc.addFeature({
          id: last, type: 'box', name: `Box ${i}`,
          values: { dx: 'size', dy: '10', dz: '10', x: String(i * 15) }, inputs: {},
        });
      }
      return last;
    }, (doc) => doc.setParameter({ name: 'size', expression: '12', unit: 'mm' }));
  }

  // --- patterns: one feature, a lot of geometry
  for (const count of [10, 50, 150]) {
    await measure('linear pattern', `${count} copies`, (doc) => {
      doc.setParameter({ name: 'gap', expression: '15', unit: 'mm' });
      doc.addFeature({
        id: id('unit'), type: 'box', name: 'Unit',
        values: { dx: '10', dy: '10', dz: '10' }, inputs: {},
      });
      doc.addFeature({
        id: id('pat'), type: 'linearPattern', name: 'Pattern',
        values: { count: String(count), spacing: 'gap', dx: '1' },
        inputs: { base: id('unit') },
      });
      return id('pat');
    }, (doc) => doc.setParameter({ name: 'gap', expression: '18', unit: 'mm' }));
  }

  // --- does an edit actually reuse the branches it did not touch?
  {
    const doc = new Document(kernel, undefined, solver);
    doc.setParameter({ name: 'left', expression: '20', unit: 'mm' });
    doc.setParameter({ name: 'right', expression: '20', unit: 'mm' });
    for (let i = 0; i < 20; i++) {
      doc.addFeature({
        id: id(`l${i}`), type: 'box', name: `L${i}`,
        values: { dx: 'left', dy: '10', dz: '10', x: String(i * 25) }, inputs: {},
      });
      doc.addFeature({
        id: id(`r${i}`), type: 'box', name: `R${i}`,
        values: { dx: 'right', dy: '10', dz: '10', x: String(i * 25), y: '40' }, inputs: {},
      });
    }
    await doc.recompute();
    doc.setParameter({ name: 'left', expression: '22', unit: 'mm' });
    const [after, elapsed] = await time(() => doc.recompute());
    console.log(
      `\nincremental recompute: touched "left" of 40 features\n` +
      `  rebuilt ${after.computed.length}, reused ${after.reused.length}, ` +
      `skipped ${after.skipped.length} in ${ms(elapsed)}`,
    );

    // And scrubbing the same parameter back and forth should be nearly free the second
    // time, because the old hash is still in the cache.
    doc.setParameter({ name: 'left', expression: '20', unit: 'mm' });
    const [back, backMs] = await time(() => doc.recompute());
    console.log(`  scrubbed back: reused ${back.reused.length} in ${ms(backMs)}`);
  }

  // --- 100 successive edits: does anything grow without bound?
  {
    const doc = new Document(kernel, undefined, solver);
    doc.setParameter({ name: 'w', expression: '60', unit: 'mm' });
    const sk = plateSketch(doc, 'w', '40');
    doc.addFeature({
      id: id('plate'), type: 'extrude', name: 'Plate',
      values: { distance: '8' }, inputs: { profile: sk },
    });
    doc.addFeature({
      id: id('hole'), type: 'hole', name: 'Hole',
      values: { standard: 'M4', fit: 'normal', x: '30', y: '20', z: '8', depth: '10' },
      inputs: { base: id('plate') },
    });
    await doc.recompute();

    const handlesBefore = kernel.registry.size;
    const samples: number[] = [];
    for (let i = 0; i < 100; i++) {
      doc.setParameter({ name: 'w', expression: String(50 + i), unit: 'mm' });
      const [, elapsed] = await time(() => doc.recompute());
      samples.push(elapsed);
    }
    const first = samples.slice(0, 10).reduce((a, b) => a + b, 0) / 10;
    const last = samples.slice(-10).reduce((a, b) => a + b, 0) / 10;
    console.log(
      `\n100 successive edits (a scrubbed dimension)\n` +
      `  first 10 avg ${ms(first)}, last 10 avg ${ms(last)}\n` +
      `  handles ${handlesBefore} -> ${kernel.registry.size}, ` +
      `cache ${doc.engine.cacheSize}`,
    );
  }

  console.log('\n%s', [
    'case'.padEnd(20), 'size'.padEnd(12), 'build'.padStart(9), 'edit'.padStart(9),
    'mesh'.padStart(9), 'tris'.padStart(8), 'rebuilt'.padStart(8), 'reused'.padStart(7),
    'handles'.padStart(8),
  ].join(''));
  console.log('-'.repeat(92));
  for (const r of rows) {
    console.log([
      r.case.padEnd(20), r.size.padEnd(12), ms(r.build).padStart(9), ms(r.edit).padStart(9),
      ms(r.tessellate).padStart(9), String(r.triangles).padStart(8),
      String(r.computed).padStart(8), String(r.reused).padStart(7),
      String(r.handles).padStart(8),
    ].join(''));
  }
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
