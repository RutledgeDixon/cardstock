import { beforeAll, describe, expect, it } from 'vitest';
import { asFeatureId, type FeatureId } from '@cardstock/types';
import { Document, TEXT_FONTS, textLayout } from '@cardstock/document';
import { createOcctKernel, type OcctKernel } from '@cardstock/kernel';

/**
 * Text has to become real geometry, not a decal: a label you can print.
 *
 * This build of OCCT has no font support, so glyph outlines are extracted at build time
 * and laid out here (see text-outline.ts). What matters is that the loops they produce
 * survive the kernel — a letter's counter has to arrive as a HOLE, and the depth's sign
 * has to decide whether the letters are added or taken away.
 */
let kernel: OcctKernel;
beforeAll(async () => { kernel = await createOcctKernel(); }, 60_000);

const PLATE = asFeatureId('plate');

/** A plate with text on its top face. */
async function plateWithText(values: Record<string, string>) {
  const doc = new Document(kernel);
  doc.addFeature({
    id: PLATE, type: 'box', name: 'Plate',
    values: { dx: '60', dy: '30', dz: '5' }, inputs: {},
  });
  const built = await doc.recompute();
  const plate = built.states.get(PLATE)!.handle!;

  // The top face: the one whose normal points up.
  const description = await kernel.describeShape(plate);
  const top = description.faces.find((f) => (f.direction?.z ?? 0) > 0.99)!;
  expect(top).toBeDefined();

  const text = asFeatureId('label');
  doc.addFeature({
    id: text, type: 'text', name: 'Label',
    values, inputs: { base: PLATE },
    selections: { faces: [{ kind: 'face', origin: { featureId: PLATE, index: top.index }, fingerprint: top }] },
  });
  return { doc, text, plateVolume: (await kernel.massProperties(plate)).volume };
}

const volumeOf = async (doc: Document, id: FeatureId) => {
  const result = await doc.recompute();
  const state = result.states.get(id)!;
  expect(state.message).toBeUndefined();
  expect(state.status).toBe('ok');
  return (await kernel.massProperties(state.handle!)).volume;
};

describe('text on a face', () => {
  it('stands proud of the surface when the depth is positive', async () => {
    const { doc, text, plateVolume } = await plateWithText({
      text: 'AB', size: '8', depth: '1', font: 'sans',
    });
    const volume = await volumeOf(doc, text);
    expect(volume).toBeGreaterThan(plateVolume);
    // Two letters 8mm tall, 1mm proud: a few tens of cubic millimetres, not hundreds.
    expect(volume - plateVolume).toBeGreaterThan(5);
    expect(volume - plateVolume).toBeLessThan(80);
  }, 60_000);

  it('cuts into the surface when the depth is negative', async () => {
    const { doc, text, plateVolume } = await plateWithText({
      text: 'AB', size: '8', depth: '-1', font: 'sans',
    });
    const volume = await volumeOf(doc, text);
    expect(volume).toBeLessThan(plateVolume);
  }, 60_000);

  it('gives the same letters the same volume whichever way they go', async () => {
    // The sign decides direction only; a 1mm raised A and a 1mm sunk A are the same
    // letters, so what is added and what is removed must match.
    const raised = await plateWithText({ text: 'AB', size: '8', depth: '1', font: 'sans' });
    const sunk = await plateWithText({ text: 'AB', size: '8', depth: '-1', font: 'sans' });
    const added = (await volumeOf(raised.doc, raised.text)) - raised.plateVolume;
    const removed = sunk.plateVolume - (await volumeOf(sunk.doc, sunk.text));
    expect(added).toBeCloseTo(removed, 3);
  }, 90_000);

  it('makes a letter s counter a real hole', async () => {
    // "O" raised is a ring, not a disc. A filled O would weigh distinctly more, which
    // is the only way to tell a hole that arrived from one that was quietly dropped.
    const { doc, text, plateVolume } = await plateWithText({
      text: 'O', size: '10', depth: '1', font: 'mono',
    });
    const ring = (await volumeOf(doc, text)) - plateVolume;
    const layout = textLayout('O', 'mono', 10);
    const outer = Math.abs(layout.regions[0]![0]!.signedArea);
    const hole = Math.abs(layout.regions[0]![1]!.signedArea);
    expect(hole).toBeGreaterThan(0);
    expect(ring).toBeCloseTo((outer - hole) * 1, 3);
  }, 60_000);

  it('builds in every font offered', async () => {
    for (const font of TEXT_FONTS) {
      const { doc, text, plateVolume } = await plateWithText({
        text: 'Ag8', size: '6', depth: '0.8', font,
      });
      expect(await volumeOf(doc, text), font).toBeGreaterThan(plateVolume);
    }
  }, 180_000);

  it('says what is wrong rather than failing obscurely', async () => {
    for (const [values, expected] of [
      [{ text: '', size: '8', depth: '1' }, /type something/],
      [{ text: 'A', size: '8', depth: '0' }, /must not be zero/],
      [{ text: 'A', size: '0', depth: '1' }, /size must be positive/],
    ] as const) {
      const { doc, text } = await plateWithText(values as Record<string, string>);
      const result = await doc.recompute();
      expect(result.states.get(text)!.message).toMatch(expected);
    }
  }, 60_000);

  it('reads along the face rather than along whatever axis it was given', async () => {
    // A sketch plane's in-plane X is chosen for stability, not for reading: on a top
    // face it runs along -Y, and a label laid out on it came out sideways, off the
    // edge of the part. Text works out its own reading direction from the normal.
    const { doc, text } = await plateWithText({ text: 'II', size: '6', depth: '1', font: 'mono' });
    const result = await doc.recompute();
    const bounds = await kernel.boundingBox(result.states.get(text)!.handle!);
    const plateBounds = await kernel.boundingBox(result.states.get(PLATE)!.handle!);
    // Two letters side by side run along X, so the text is wider than it is tall; the
    // plate is 60 x 30, so a label that ran along Y would be the other way round.
    const grewInX = bounds.max.x - bounds.min.x > plateBounds.max.x - plateBounds.min.x;
    const grewInY = bounds.max.y - bounds.min.y > plateBounds.max.y - plateBounds.min.y;
    expect(grewInX).toBe(false);
    expect(grewInY).toBe(false);
    // Letters stand proud of the top, and nowhere else.
    expect(bounds.max.z).toBeCloseTo(plateBounds.max.z + 1, 6);
  }, 60_000);

  it('turns on the face when given an angle', async () => {
    // A label long enough to fit across the plate but not along it: at 0 degrees it
    // stays within the 60 x 30 top, and turned by a right angle it hangs off the sides.
    const long = 'IIIIIIII';
    const span = async (angle: string) => {
      const made = await plateWithText({ text: long, size: '8', depth: '1', font: 'mono', angle });
      const r = await made.doc.recompute();
      expect(r.states.get(made.text)!.status).toBe('ok');
      const b = await kernel.boundingBox(r.states.get(made.text)!.handle!);
      return { x: b.max.x - b.min.x, y: b.max.y - b.min.y };
    };
    const straight = await span('0');
    const turned = await span('90');
    expect(straight.x).toBeCloseTo(60, 3);
    expect(straight.y).toBeCloseTo(30, 3);
    // Turned, the same letters run across the short way and overhang it.
    expect(turned.y).toBeGreaterThan(30);
    expect(turned.x).toBeCloseTo(60, 3);
  }, 90_000);
});
