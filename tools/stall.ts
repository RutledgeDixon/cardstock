/**
 * Are the periodic multi-second stalls in OCCT, or in the browser?
 *
 * The browser showed a steady ~190ms rebuild with an occasional ~5000ms one, landing on
 * whichever kernel call happened to be in flight. Running the identical workload in Node
 * separates the two possibilities: same stalls means OCCT or the WASM heap, no stalls
 * means something about the browser environment.
 */
import { asFeatureId } from '@cardstock/types';
import { Document } from '@cardstock/document';
import { PlaneGcsSolver, createOcctKernel } from '@cardstock/kernel';

const id = (s: string) => asFeatureId(s);
const kernel = await createOcctKernel();
const solver = await PlaneGcsSolver.create();

const doc = new Document(kernel, undefined, solver);
doc.setParameter({ name: 'gap', expression: '15', unit: 'mm' });
doc.addFeature({
  id: id('unit'), type: 'box', name: 'Unit',
  values: { dx: '10', dy: '10', dz: '10' }, inputs: {},
});
doc.addFeature({
  id: id('pat'), type: 'linearPattern', name: 'Pattern',
  values: { count: '100', spacing: 'gap', dx: '1' }, inputs: { base: id('unit') },
});
await doc.recompute();

const times: number[] = [];
for (let i = 0; i < 30; i++) {
  doc.setParameter({ name: 'gap', expression: String(15 + i), unit: 'mm' });
  const at = performance.now();
  const result = await doc.recompute();
  await kernel.tessellate(result.states.get(id('pat'))!.handle!, 'x' as never, {
    linearDeflection: 0.1, angularDeflection: 0.35,
  });
  times.push(Math.round(performance.now() - at));
}

const sorted = [...times].sort((a, b) => a - b);
console.log(times.join(' '));
console.log(
  `median ${sorted[Math.floor(sorted.length / 2)]}ms, ` +
  `worst ${sorted[sorted.length - 1]}ms, ` +
  `over 1s: ${times.filter((t) => t > 1000).length}/${times.length}`,
);
