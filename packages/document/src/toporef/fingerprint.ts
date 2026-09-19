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
/** Distance between two entities' positions within their bounding boxes, 0..√3. */
export const positionError = (a: EntityFingerprint, b: EntityFingerprint): number =>
  distance(a.centroidNormalised, b.centroidNormalised);
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
  const position = Math.max(0, 1 - positionError(reference, candidate) / 0.35);

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

  // What the entity is attached to, by size: an edge between a small end face and
  // the OUTER wall is not the edge between that end face and the INNER wall, however
  // alike their positions look once the part has stretched. And curvature: an inner
  // wall bends tighter than an outer one.
  const attached = measureSimilarity(reference.neighbourMeasures, candidate.neighbourMeasures);
  const bend = curvatureSimilarity(reference.curvature, candidate.curvature);
  // How far out from the shape's centre: the signal that survives a stretch best.
  const radial = reference.radialNormalised !== undefined && candidate.radialNormalised !== undefined
    ? Math.max(0, 1 - Math.abs(reference.radialNormalised - candidate.radialNormalised) / 0.12)
    : reference.radialNormalised === candidate.radialNormalised ? null : 0.75;

  // A signal absent on both sides (a fingerprint from before it existed) is left out
  // and the rest re-weighted, rather than counted as agreement it never measured.
  const terms: [number | null, number][] = [
    [position, 0.23], [orientation, 0.27], [size, 0.08], [neighbours, 0.08],
    [attached, 0.12], [bend, 0.07], [radial, 0.15],
  ];
  let total = 0, weight = 0;
  for (const [value, w] of terms) {
    if (value === null) continue;
    total += value * w;
    weight += w;
  }
  return Math.round((total / weight) * 1e9) / 1e9;
}

/** 1 when the sorted lists of adjacent-face area ratios agree; falls off with the
 *  mean relative difference. Absent on either side (older files) counts as neutral. */
function measureSimilarity(a: readonly number[] | undefined, b: readonly number[] | undefined): number | null {
  // Absent on both sides (a fingerprint from before this signal existed): not
  // measured, so not counted; absent on one side only: mildly suspicious.
  if (!a && !b) return null;
  if (!a || !b) return 0.75;
  if (a.length !== b.length) return 0.25;
  if (a.length === 0) return 1;
  let total = 0;
  for (let i = 0; i < a.length; i++) {
    const larger = Math.max(a[i]!, b[i]!);
    total += larger > 0 ? Math.abs(a[i]! - b[i]!) / larger : 0;
  }
  return Math.max(0, 1 - (total / a.length) * 2);
}

function curvatureSimilarity(a: number | undefined, b: number | undefined): number | null {
  if (a === undefined && b === undefined) return null;
  if (a === undefined || b === undefined) return 0.75;
  const larger = Math.max(a, b);
  if (larger < 1e-12) return 1;
  return Math.max(0, 1 - Math.abs(a - b) / larger);
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

  if (runnerUp && winner.score - runnerUp.score < thresholds.margin
    && !clearlyCloser(reference, candidates, winner.index, runnerUp.index)) {
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

/**
 * Near-tie breaker. Position falls off over a third of the bounding box, which is
 * right for a resize but too gentle to separate the inner and outer edges of a 3 mm
 * wall on a 70 mm part: nudge the part by a millimetre and the two score within the
 * margin of each other, and a fillet that plainly belongs on the outer edge is
 * declared ambiguous. When everything else is a wash, the candidate sitting where the
 * pick was made — within a tenth of the box, and clearly nearer than the next one — is the one the user meant.
 */
function clearlyCloser(
  reference: EntityFingerprint,
  candidates: readonly EntityFingerprint[],
  winnerIndex: number,
  runnerUpIndex: number,
): boolean {
  const winner = candidates.find((c) => c.index === winnerIndex);
  const runnerUp = candidates.find((c) => c.index === runnerUpIndex);
  if (!winner || !runnerUp) return false;
  const near = positionError(reference, winner);
  const far = positionError(reference, runnerUp);
  // Two entities at the SAME spot (a symmetric part) stay ambiguous: the runner-up must
  // be measurably further away, not merely no closer.
  return near < 0.1 && far - near >= 0.02 && near * 1.5 <= far;
}
