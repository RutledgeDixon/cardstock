import { describe, expect, it } from 'vitest';
import { asFeatureId } from '@cardstock/types';
import { Document, MockKernel, MockSolver } from '@cardstock/document';
import { bodyFeatures, leafFeatures } from './model-bridge.js';

/**
 * Which features count as bodies. This is what Combine's "only one body" reason and
 * the export compound both read, and the two used to disagree: one counted a sketch's
 * reference to the face it sits on as consuming that body.
 */
describe('bodyFeatures', () => {
  it('a sketch on a body does not consume it, and a bare sketch is not a body', () => {
    const doc = new Document(new MockKernel(), undefined, new MockSolver());
    const plate = asFeatureId('plate');
    doc.addFeature({ id: plate, type: 'box', name: 'Plate', values: { dx: '10', dy: '10', dz: '2' }, inputs: {} });

    // Drawn on the plate's face: references it, does not absorb it.
    const { id: sketch } = doc.addSketch({ kind: 'origin', plane: 'xy' }, { base: plate });
    expect(leafFeatures(doc)).toEqual([plate, sketch]);
    expect(bodyFeatures(doc)).toEqual([plate]);

    const boss = asFeatureId('boss');
    doc.addFeature({ id: boss, type: 'extrude', name: 'Boss', values: { distance: '5' }, inputs: { profile: sketch } });
    expect(bodyFeatures(doc)).toEqual([plate, boss]);

    const union = asFeatureId('u');
    doc.addFeature({ id: union, type: 'union', name: 'Union', values: {}, inputs: { base: plate, tool: boss } });
    expect(bodyFeatures(doc)).toEqual([union]);
  });
});
