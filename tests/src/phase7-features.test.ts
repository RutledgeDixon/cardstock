import { beforeAll, describe, expect, it } from 'vitest';
import { asFeatureId } from '@cardstock/types';
import { Document, findFastener } from '@cardstock/document';
import { PlaneGcsSolver, createOcctKernel, type OcctKernel } from '@cardstock/kernel';

/**
 * The Phase 7 features driven through the real document against real geometry, with
 * volumes checked against closed-form values.
 */
let kernel: OcctKernel;
let solver: PlaneGcsSolver;
beforeAll(async () => {
  kernel = await createOcctKernel();
  solver = await PlaneGcsSolver.create();
}, 60_000);

const doc = () => new Document(kernel, undefined, solver);
const BASE = asFeatureId('base');

const withBox = (d: Document, dx = 40, dy = 40, dz = 20) => {
  d.addFeature({
    id: BASE, type: 'box', name: 'Base',
    values: { dx: String(dx), dy: String(dy), dz: String(dz) }, inputs: {},
  });
};

const volumeOf = async (d: Document, id: string) => {
  const result = await d.recompute();
  const state = result.states.get(asFeatureId(id))!;
  expect(state.status, state.message ?? '').toBe('ok');
  return (await kernel.massProperties(state.handle!)).volume;
};

describe('holes', () => {
  it('takes its diameter from the fastener table', async () => {
    const d = doc();
    withBox(d);
    d.addFeature({
      id: asFeatureId('h'), type: 'hole', name: 'Bolt hole',
      values: { x: '20', y: '20', z: '20', depth: '20', standard: 'M4', fit: 'normal' },
      inputs: { base: BASE },
    });
    // M4 normal clearance is 4.5mm.
    const expected = 40 * 40 * 20 - Math.PI * (4.5 / 2) ** 2 * 20;
    expect(await volumeOf(d, 'h')).toBeCloseTo(expected, 2);
  });

  it('cuts a tap drill smaller than a clearance hole', async () => {
    const build = async (fit: string) => {
      const d = doc();
      withBox(d);
      d.addFeature({
        id: asFeatureId('h'), type: 'hole', name: 'Hole',
        values: { x: '20', y: '20', z: '20', depth: '20', standard: 'M4', fit },
        inputs: { base: BASE },
      });
      return volumeOf(d, 'h');
    };
    // A tap hole removes less material than a clearance hole, so more solid remains.
    expect(await build('tap')).toBeGreaterThan(await build('normal'));
    expect(await build('close')).toBeGreaterThan(await build('loose'));
  });

  it('applies undersize compensation to the diameter', async () => {
    const d = doc();
    withBox(d);
    d.addFeature({
      id: asFeatureId('h'), type: 'hole', name: 'Hole',
      values: {
        x: '20', y: '20', z: '20', depth: '20',
        standard: 'M3', fit: 'normal', compensation: '0.3',
      },
      inputs: { base: BASE },
    });
    const expected = 40 * 40 * 20 - Math.PI * ((3.4 + 0.3) / 2) ** 2 * 20;
    expect(await volumeOf(d, 'h')).toBeCloseTo(expected, 2);
  });

  it('lets an explicit diameter override the table', async () => {
    const d = doc();
    withBox(d);
    d.addFeature({
      id: asFeatureId('h'), type: 'hole', name: 'Hole',
      values: { x: '20', y: '20', z: '20', depth: '20', diameter: '12', standard: 'M3' },
      inputs: { base: BASE },
    });
    expect(await volumeOf(d, 'h'))
      .toBeCloseTo(40 * 40 * 20 - Math.PI * 36 * 20, 2);
  });

  it('cuts a counterbore for the screw head', async () => {
    const d = doc();
    withBox(d);
    d.addFeature({
      id: asFeatureId('h'), type: 'hole', name: 'Hole',
      values: {
        x: '20', y: '20', z: '20', depth: '20',
        standard: 'M4', fit: 'normal', style: 'counterbore',
      },
      inputs: { base: BASE },
    });
    const m4 = findFastener('M4')!;
    const shaft = Math.PI * (m4.normal / 2) ** 2 * 20;
    // The bore replaces the top of the shaft, so only the extra ring counts.
    const bore = (Math.PI * (m4.headDiameter / 2) ** 2 - Math.PI * (m4.normal / 2) ** 2)
      * m4.headHeight;
    expect(await volumeOf(d, 'h')).toBeCloseTo(40 * 40 * 20 - shaft - bore, 1);
  });

  it('names an unknown fastener rather than guessing one', async () => {
    const d = doc();
    withBox(d);
    d.addFeature({
      id: asFeatureId('h'), type: 'hole', name: 'Hole',
      values: { x: '20', y: '20', z: '20', depth: '20', standard: 'M4.5' },
      inputs: { base: BASE },
    });
    const state = (await d.recompute()).states.get(asFeatureId('h'))!;
    expect(state.status).toBe('error');
    expect(state.message).toMatch(/"M4.5" is not a fastener size/);
  });

  it('follows a parameter, like everything else', async () => {
    const d = doc();
    d.setParameter({ name: 'plate', expression: '40', unit: 'mm' });
    d.addFeature({
      id: BASE, type: 'box', name: 'Base',
      values: { dx: 'plate', dy: 'plate', dz: '10' }, inputs: {},
    });
    d.addFeature({
      id: asFeatureId('h'), type: 'hole', name: 'Hole',
      values: { x: 'plate / 2', y: 'plate / 2', z: '10', depth: '10', standard: 'M3' },
      inputs: { base: BASE },
    });
    await d.recompute();
    d.setParameter({ name: 'plate', expression: '60', unit: 'mm' });
    expect(await volumeOf(d, 'h'))
      .toBeCloseTo(60 * 60 * 10 - Math.PI * (3.4 / 2) ** 2 * 10, 2);
  });
});

describe('patterns', () => {
  it('repeats a body along a direction', async () => {
    const d = doc();
    d.addFeature({
      id: BASE, type: 'box', name: 'Tooth',
      values: { dx: '5', dy: '5', dz: '5' }, inputs: {},
    });
    d.addFeature({
      id: asFeatureId('p'), type: 'linearPattern', name: 'Row',
      values: { count: '4', spacing: '10', dx: '1', dy: '0', dz: '0' },
      inputs: { base: BASE },
    });
    // Spaced 10 apart with 5mm cubes, so none overlap: four separate volumes.
    expect(await volumeOf(d, 'p')).toBeCloseTo(4 * 125, 4);
  });

  it('merges overlapping copies rather than double counting', async () => {
    const d = doc();
    d.addFeature({
      id: BASE, type: 'box', name: 'Block',
      values: { dx: '10', dy: '10', dz: '10' }, inputs: {},
    });
    d.addFeature({
      id: asFeatureId('p'), type: 'linearPattern', name: 'Row',
      values: { count: '2', spacing: '5', dx: '1', dy: '0', dz: '0' },
      inputs: { base: BASE },
    });
    // Two 10mm cubes 5mm apart occupy 15mm, not 20.
    expect(await volumeOf(d, 'p')).toBeCloseTo(15 * 10 * 10, 4);
  });

  it('repeats around an axis', async () => {
    const d = doc();
    d.addFeature({
      id: BASE, type: 'cylinder', name: 'Peg',
      values: { radius: '2', height: '5', x: '20', y: '0', z: '0' }, inputs: {},
    });
    d.addFeature({
      id: asFeatureId('p'), type: 'circularPattern', name: 'Ring',
      values: { count: '6', angle: '360', x: '0', y: '0', z: '0', axisZ: '1' },
      inputs: { base: BASE },
    });
    // Six pegs at radius 20 do not touch, so the volume is simply six of them.
    expect(await volumeOf(d, 'p')).toBeCloseTo(6 * Math.PI * 4 * 5, 3);
  });

  it('refuses a count that would hang the worker', async () => {
    const d = doc();
    withBox(d, 5, 5, 5);
    d.addFeature({
      id: asFeatureId('p'), type: 'linearPattern', name: 'Row',
      values: { count: '5000', spacing: '10', dx: '1' }, inputs: { base: BASE },
    });
    const state = (await d.recompute()).states.get(asFeatureId('p'))!;
    expect(state.status).toBe('error');
    expect(state.message).toMatch(/too many \(limit 200\)/);
  });

  it('refuses a pattern of one', async () => {
    const d = doc();
    withBox(d, 5, 5, 5);
    d.addFeature({
      id: asFeatureId('p'), type: 'linearPattern', name: 'Row',
      values: { count: '1', spacing: '10', dx: '1' }, inputs: { base: BASE },
    });
    expect((await d.recompute()).states.get(asFeatureId('p'))!.message)
      .toMatch(/count of at least 2/);
  });
});

describe('shell and mirror', () => {
  it('hollows a box into a tray', async () => {
    const d = doc();
    withBox(d, 40, 30, 20);
    const first = await d.recompute();
    const description = await kernel.describeShape(first.states.get(BASE)!.handle!);
    const top = description.faces.find((f) => f.direction!.z > 0.99)!;

    d.addFeature({
      id: asFeatureId('s'), type: 'shell', name: 'Hollow',
      values: { thickness: '2' }, inputs: { base: BASE },
      // Selections are keyed by role; the shell reads its open faces from `faces`.
      selections: {
        faces: [{
          kind: 'face', origin: { featureId: BASE, index: top.index }, fingerprint: top,
        }],
      },
    });

    expect(await volumeOf(d, 's')).toBeCloseTo(40 * 30 * 20 - 36 * 26 * 18, 1);
  });

  it('mirrors and keeps the original by default', async () => {
    const d = doc();
    d.addFeature({
      id: BASE, type: 'box', name: 'Half',
      values: { dx: '10', dy: '10', dz: '10', x: '5' }, inputs: {},
    });
    d.addFeature({
      id: asFeatureId('m'), type: 'mirror', name: 'Symmetric',
      values: { x: '0', y: '0', z: '0', normalX: '1' }, inputs: { base: BASE },
    });
    expect(await volumeOf(d, 'm')).toBeCloseTo(2000, 4);
  });

  it('can replace the original instead', async () => {
    const d = doc();
    d.addFeature({
      id: BASE, type: 'box', name: 'Half',
      values: { dx: '10', dy: '10', dz: '10', x: '5' }, inputs: {},
    });
    d.addFeature({
      id: asFeatureId('m'), type: 'mirror', name: 'Flipped',
      values: { x: '0', y: '0', z: '0', normalX: '1', keepOriginal: '0' },
      inputs: { base: BASE },
    });
    expect(await volumeOf(d, 'm')).toBeCloseTo(1000, 4);
  });
});

describe('malformed selections', () => {
  it('reports them instead of crashing the rebuild', async () => {
    // Selections arrive from a file, so they are untrusted input.
    const d = doc();
    withBox(d);
    d.addFeature({
      id: asFeatureId('s'), type: 'shell', name: 'Hollow',
      values: { thickness: '2' }, inputs: { base: BASE },
      selections: { faces: 'not a list' } as never,
    });
    const state = (await d.recompute()).states.get(asFeatureId('s'))!;
    expect(state.status).toBe('error');
    expect(state.message).toMatch(/is not a list/);
  });
});

describe('revolve', () => {
  it('turns a sketched profile into a solid of revolution', async () => {
    const d = doc();
    const { sketch, id } = d.addSketch({ kind: 'origin', plane: 'xz' });
    const a = sketch.addPoint(10, 0);
    const b = sketch.addPoint(15, 0);
    const c = sketch.addPoint(15, 8);
    const e = sketch.addPoint(10, 8);
    sketch.addLine(a, b); sketch.addLine(b, c); sketch.addLine(c, e); sketch.addLine(e, a);

    d.addFeature({
      id: asFeatureId('r'), type: 'revolve', name: 'Ring',
      values: { angle: '360', axisZ: '1' }, inputs: { profile: id },
    });
    expect(await volumeOf(d, 'r'))
      .toBeCloseTo(Math.PI * (15 * 15 - 10 * 10) * 8, 2);
  });
});
