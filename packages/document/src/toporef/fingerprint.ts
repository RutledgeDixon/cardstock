import type { EntityFingerprint, Vec3 } from '@cardstock/types';
import { DEFAULT_THRESHOLDS, type MatchThresholds, type Resolution } from './types.js';

/**
 * Fingerprint scoring.
 *
 * Geometry type is a hard filter, never a score: a plane is never a cylinder, and letting
 * a strong positional match outvote a type mismatch is how resolvers end up attaching a
 * fillet to the wrong kind of thing.
 */

const distance = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

/** Multiset similarity, 0..1. */
function neighbourSimilarity(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const counts = new Map<string, number>();
  for (const t of a) counts.set(t, (counts.get(t) ?? 0) + 1);
  let shared = 0;
  for (const t of b) {
    const n = counts.get(t) ?? 0;
    if (n > 0) { shared++; counts.set(t, n - 1); }
  }
  return (2 * shared) / (a.length + b.length);
}

/**
 * How well `candidate` matches `reference`, 0..1. Returns null when the two are not even
 * comparable, which keeps incomparable pairs out of the ranking rather than at the bottom
 * of it.
 */
export function scoreMatch(
  reference: EntityFingerprint,
  candidate: EntityFingerprint,
): number | null {
  if (reference.kind !== candidate.kind) return null;
  if (reference.geometryType !== candidate.geometryType) return null;

  // Position within the bounding box. The dominant signal: it is invariant to the
  // resize that breaks index-based references in the first place.
  const positionError = distance(reference.centroidNormalised, candidate.centroidNormalised);
  const position = Math.max(0, 1 - positionError / 0.35);

  // Orientation. Survives resizing exactly, and separates the six faces of a box.
  let orientation = 0.5;
  if (reference.direction && candidate.direction) {
    orientation = (dot(reference.direction, candidate.direction) + 1) / 2;
    // Anti-parallel is a different entity, not a near miss.
    if (orientation < 0.5) orientation = 0;
  } else if (!reference.direction && !candidate.direction) {
    orientation = 1;
  }

  // Relative size. Robust to uniform scaling, weak on its own.
  const larger = Math.max(reference.measureRatio, candidate.measureRatio);
  const size = larger > 0
    ? 1 - Math.abs(reference.measureRatio - candidate.measureRatio) / larger
    : 1;

  const neighbours = neighbourSimilarity(reference.neighbourTypes, candidate.neighbourTypes);

  return position * 0.45 + orientation * 0.3 + size * 0.15 + neighbours * 0.1;
}

/**
 * Best candidate, or a refusal.
 *
 * Never guesses. The winner must clear an absolute threshold AND beat the runner-up by a
 * margin; a near-tie means the model genuinely contains two similar entities and picking
 * one silently would be worse than stopping. A wrong fillet that looks plausible gets
 * printed before anyone notices.
 */
export function bestMatch(
  reference: EntityFingerprint,
  candidates: readonly EntityFingerprint[],
  thresholds: MatchThresholds = DEFAULT_THRESHOLDS,
): Resolution {
  const scored = candidates
    .map((candidate) => ({ index: candidate.index, score: scoreMatch(reference, candidate) }))
    .filter((s): s is { index: number; score: number } => s.score !== null)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return {
      ok: false,
      reason: `no ${reference.kind} of type "${reference.geometryType}" remains in the shape`,
      candidates: [],
    };
  }

  const winner = scored[0]!;
  const runnerUp = scored[1];

  if (winner.score < thresholds.accept) {
    return {
      ok: false,
      reason:
        `the referenced ${reference.kind} no longer matches anything closely enough ` +
        `(best score ${winner.score.toFixed(2)})`,
      candidates: scored.slice(0, 4),
    };
  }

  if (runnerUp && winner.score - runnerUp.score < thresholds.margin) {
    return {
      ok: false,
      reason:
        `the referenced ${reference.kind} is ambiguous — ${reference.kind} ${winner.index} ` +
        `and ${runnerUp.index} match equally well`,
      candidates: scored.slice(0, 4),
    };
  }

  return { ok: true, index: winner.index, method: 'fingerprint', confidence: winner.score };
}
