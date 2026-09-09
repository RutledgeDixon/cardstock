import { describe, expect, it } from 'vitest';
import type {
  EntityFingerprint, FeatureId, ShapeDescription, ShapeHistory, Vec3,
} from '@cardstock/types';
import { captureTopoRef, resolveTopoRef, type HistoryStep } from './resolver.js';
import type { TopoRef } from './types.js';

const edge = (index: number, at: Vec3, over: Partial<EntityFingerprint> = {}): EntityFingerprint => ({
  kind: 'edge', index, geometryType: 'line',
  centroid: at, centroidNormalised: at,
  direction: { x: 0, y: 0, z: 1 },
  measure: 20, measureRatio: 0.1,
  neighbourTypes: ['plane', 'plane'],
  ...over,
});

const shape = (edges: EntityFingerprint[]): ShapeDescription => ({
  faces: [], edges, vertices: [],
  bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
});

/** Four vertical corners of a box, at fixed bbox fractions. */
const corners = (indices: number[]) => [
  edge(indices[0]!, { x: 0, y: 0, z: 0.5 }),
  edge(indices[1]!, { x: 1, y: 0, z: 0.5 }),
  edge(indices[2]!, { x: 1, y: 1, z: 0.5 }),
  edge(indices[3]!, { x: 0, y: 1, z: 0.5 }),
];

const history = (over: Partial<ShapeHistory['inputs'][number]> = {}): ShapeHistory => ({
  inputs: [{
    modifiedFaces: new Map(), modifiedEdges: new Map(),
    generatedFaces: new Map(), deletedFaces: [], deletedEdges: [],
    ...over,
  }],
});

const step = (h: ShapeHistory | null): HistoryStep =>
  ({ featureId: 'op' as FeatureId, inputIndex: 0, history: h });

const refTo = (index: number, from: EntityFingerprint[]): TopoRef =>
  captureTopoRef('box' as FeatureId, 'edge', index, shape(from))!;

describe('capture', () => {
  it('mints a reference carrying the entity fingerprint', () => {
    const ref = refTo(2, corners([0, 1, 2, 3]));
    expect(ref.origin).toEqual({ featureId: 'box', index: 2 });
    expect(ref.fingerprint.centroidNormalised).toEqual({ x: 1, y: 1, z: 0.5 });
  });

  it('returns null for an index that does not exist', () => {
    expect(captureTopoRef('box' as FeatureId, 'edge', 99, shape(corners([0, 1, 2, 3])))).toBeNull();
  });
});

describe('same-feature re-identification (the common case)', () => {
  it('takes the index fast path when nothing moved', () => {
    const before = corners([0, 1, 2, 3]);
    const ref = refTo(2, before);
    const result = resolveTopoRef(ref, shape(before));
    expect(result).toMatchObject({ ok: true, index: 2, method: 'index' });
  });

  it('follows a corner edge through a renumbering after a resize', () => {
    // Provenance cannot help here: a primitive rebuild has no history at all.
    const ref = refTo(2, corners([0, 1, 2, 3]));
    const result = resolveTopoRef(ref, shape(corners([9, 4, 7, 1])));
    expect(result).toMatchObject({ ok: true, index: 7, method: 'fingerprint' });
  });

  it('refuses rather than guessing between two identical candidates', () => {
    const ref = refTo(0, corners([0, 1, 2, 3]));
    const twins = [edge(5, { x: 0, y: 0, z: 0.5 }), edge(6, { x: 0, y: 0, z: 0.5 })];
    const result = resolveTopoRef(ref, shape(twins));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/ambiguous/);
  });

  it('refuses when the entity is simply gone', () => {
    const ref = refTo(0, corners([0, 1, 2, 3]));
    const result = resolveTopoRef(ref, shape([edge(0, { x: 0.5, y: 0.5, z: 0.5 }, {
      direction: { x: 1, y: 0, z: 0 },
    })]));
    expect(result.ok).toBe(false);
  });
});

describe('cross-feature mapping via provenance', () => {
  it('follows an index through an operation that renumbered it', () => {
    const ref = refTo(2, corners([0, 1, 2, 3]));
    // A boolean turned input edge 2 into result edge 11.
    const chain = [step(history({ modifiedEdges: new Map([[2, [11]]]) }))];
    const target = shape([edge(11, { x: 1, y: 1, z: 0.5 }), edge(4, { x: 0, y: 0, z: 0.5 })]);
    const result = resolveTopoRef(ref, target, chain);
    expect(result).toMatchObject({ ok: true, index: 11, method: 'provenance', confidence: 1 });
  });

  it('does not assume an unmentioned edge kept its index', () => {
    // History records only CHANGES. Reading an absent entry as "still at the same index"
    // is wrong: an operation can leave an edge untouched while the shape renumbers around
    // it, and carrying the index forward then lands on a real but unrelated edge. So an
    // absent mapping must fall through to fingerprinting, which asks what the entity
    // looks like rather than what number it had.
    const ref = refTo(2, corners([0, 1, 2, 3]));
    const chain = [step(history({ modifiedEdges: new Map([[7, [9]]]) }))]; // a different edge
    const renumbered = shape(corners([3, 0, 8, 5])); // the (1,1) corner is now index 8
    const result = resolveTopoRef(ref, renumbered, chain);
    expect(result).toMatchObject({ ok: true, index: 8, method: 'fingerprint' });
  });

  it('chains across several operations', () => {
    const ref = refTo(2, corners([0, 1, 2, 3]));
    const chain = [
      step(history({ modifiedEdges: new Map([[2, [8]]]) })),
      step(history({ modifiedEdges: new Map([[8, [3]]]) })),
    ];
    const target = shape([edge(3, { x: 1, y: 1, z: 0.5 })]);
    expect(resolveTopoRef(ref, target, chain)).toMatchObject({ ok: true, index: 3, method: 'provenance' });
  });

  it('reports a reference destroyed by a later feature', () => {
    const ref = refTo(2, corners([0, 1, 2, 3]));
    const chain = [step(history({ deletedEdges: [2] }))];
    const result = resolveTopoRef(ref, shape([]), chain);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/was removed by a later feature/);
  });

  it('uses the fingerprint to choose when one edge split into several', () => {
    // A cut can split one edge into two. Which piece did the user mean? Provenance
    // narrows the field; the fingerprint picks within it.
    const ref = refTo(2, corners([0, 1, 2, 3]));
    const chain = [step(history({ modifiedEdges: new Map([[2, [5, 6]]]) }))];
    const target = shape([
      edge(5, { x: 1, y: 1, z: 0.9 }),
      edge(6, { x: 1, y: 1, z: 0.5 }), // the closer half
      edge(7, { x: 0, y: 0, z: 0.5 }),
    ]);
    expect(resolveTopoRef(ref, target, chain)).toMatchObject({ ok: true, index: 6 });
  });

  it('falls back to fingerprinting when a step has no history', () => {
    const ref = refTo(2, corners([0, 1, 2, 3]));
    const result = resolveTopoRef(ref, shape(corners([9, 4, 7, 1])), [step(null)]);
    expect(result).toMatchObject({ ok: true, index: 7 });
  });

  it('does not trust provenance that points somewhere the fingerprint rejects', () => {
    // A history map can be right that an entity survived and wrong about where it
    // landed. Verifying against the fingerprint is what catches that.
    const ref = refTo(2, corners([0, 1, 2, 3]));
    const chain = [step(history({ modifiedEdges: new Map([[2, [1]]]) }))];
    const target = shape([
      edge(1, { x: 1, y: 1, z: 0.5 }, { geometryType: 'circle' }),
      edge(2, { x: 1, y: 1, z: 0.5 }),
    ]);
    const result = resolveTopoRef(ref, target, chain);
    expect(result).toMatchObject({ ok: true, index: 2, method: 'index' });
  });
});
