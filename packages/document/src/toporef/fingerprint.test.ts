import { describe, expect, it } from 'vitest';
import type { EntityFingerprint, Vec3 } from '@cardstock/types';
import { bestMatch, scoreMatch } from './fingerprint.js';

const fp = (over: Partial<EntityFingerprint> = {}): EntityFingerprint => ({
  kind: 'edge',
  index: 0,
  geometryType: 'line',
  centroid: { x: 0, y: 0, z: 0 },
  centroidNormalised: { x: 0, y: 0, z: 0.5 },
  direction: { x: 0, y: 0, z: 1 },
  measure: 20,
  measureRatio: 0.1,
  neighbourTypes: ['plane', 'plane'],
  ...over,
});

const at = (p: Vec3, index: number, over: Partial<EntityFingerprint> = {}) =>
  fp({ index, centroidNormalised: p, ...over });

describe('type is a hard filter, never a score', () => {
  it('refuses to match across entity kinds', () => {
    expect(scoreMatch(fp(), fp({ kind: 'face' }))).toBeNull();
  });

  it('refuses to match across geometry types even when perfectly co-located', () => {
    // A strong positional match must never outvote "a plane is not a cylinder".
    expect(scoreMatch(fp({ geometryType: 'line' }), fp({ geometryType: 'circle' }))).toBeNull();
  });
});

describe('scoring', () => {
  it('scores an identical fingerprint at 1', () => {
    expect(scoreMatch(fp(), fp())!).toBeCloseTo(1, 6);
  });

  it('falls off with distance', () => {
    const near = scoreMatch(fp(), at({ x: 0.05, y: 0, z: 0.5 }, 1))!;
    const far = scoreMatch(fp(), at({ x: 0.5, y: 0.5, z: 0.5 }, 2))!;
    expect(near).toBeGreaterThan(far);
  });

  it('treats an anti-parallel direction as a different entity, not a near miss', () => {
    // The two X faces of a box sit at different normalised positions but are otherwise
    // identical; direction is what separates them.
    const flipped = scoreMatch(fp(), fp({ direction: { x: 0, y: 0, z: -1 } }))!;
    expect(flipped).toBeLessThan(0.75);
  });

  it('uses neighbours to separate lookalikes', () => {
    const sameNeighbours = scoreMatch(fp(), fp({ index: 1 }))!;
    const otherNeighbours = scoreMatch(fp(), fp({ index: 2, neighbourTypes: ['cylinder'] }))!;
    expect(sameNeighbours).toBeGreaterThan(otherNeighbours);
  });
});

describe('bestMatch never guesses', () => {
  it('picks a clear winner', () => {
    const result = bestMatch(fp(), [
      at({ x: 0, y: 0, z: 0.5 }, 7),
      at({ x: 1, y: 1, z: 0.5 }, 3),
    ]);
    expect(result).toMatchObject({ ok: true, index: 7, method: 'fingerprint' });
  });

  it('refuses when two candidates match equally well', () => {
    // A genuinely symmetric model: picking one silently would be worse than stopping.
    const result = bestMatch(fp(), [
      at({ x: 0, y: 0, z: 0.5 }, 1),
      at({ x: 0, y: 0, z: 0.5 }, 2),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/ambiguous/);
      expect(result.candidates).toHaveLength(2);
    }
  });

  it('refuses when nothing is close enough', () => {
    const result = bestMatch(fp(), [at({ x: 1, y: 1, z: 1 }, 5, { direction: { x: 1, y: 0, z: 0 } })]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no longer matches anything closely enough/);
  });

  it('refuses when the entity type has vanished entirely', () => {
    const result = bestMatch(fp({ geometryType: 'circle' }), [at({ x: 0, y: 0, z: 0.5 }, 1)]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no edge of type "circle" remains/);
  });

  it('offers candidates for a repair UI when it refuses', () => {
    const result = bestMatch(fp(), [
      at({ x: 0, y: 0, z: 0.5 }, 1), at({ x: 0, y: 0, z: 0.5 }, 2),
      at({ x: 0.02, y: 0, z: 0.5 }, 3), at({ x: 0.9, y: 0.9, z: 0.5 }, 4),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.candidates.length).toBeGreaterThan(1);
      expect(result.candidates[0]!.score).toBeGreaterThanOrEqual(result.candidates[1]!.score);
    }
  });

  it('handles an empty shape', () => {
    expect(bestMatch(fp(), []).ok).toBe(false);
  });
});

describe('the case this exists for: a resized box', () => {
  // Four vertical corner edges. Normalised coordinates put them at the same bbox
  // fractions whatever the box measures, so the reference survives the resize.
  const corners = (indices: number[]) => [
    at({ x: 0, y: 0, z: 0.5 }, indices[0]!),
    at({ x: 1, y: 0, z: 0.5 }, indices[1]!),
    at({ x: 1, y: 1, z: 0.5 }, indices[2]!),
    at({ x: 0, y: 1, z: 0.5 }, indices[3]!),
  ];

  it('follows a corner edge through a renumbering', () => {
    const reference = corners([0, 1, 2, 3])[2]!; // the (1,1) corner, index 2
    // After the rebuild OCCT hands back the same edges in a different order.
    const rebuilt = corners([9, 4, 7, 1]);
    const result = bestMatch(reference, rebuilt);
    expect(result).toMatchObject({ ok: true, index: 7 });
  });

  it('does not confuse adjacent corners', () => {
    const reference = corners([0, 1, 2, 3])[0]!;
    const result = bestMatch(reference, corners([5, 6, 7, 8]));
    expect(result).toMatchObject({ ok: true, index: 5 });
  });
});
