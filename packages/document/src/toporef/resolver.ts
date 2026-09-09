import type { FeatureId, ShapeDescription, ShapeHistory } from '@cardstock/types';
import { bestMatch, scoreMatch } from './fingerprint.js';
import {
  DEFAULT_THRESHOLDS, type MatchThresholds, type Resolution, type TopoRef,
} from './types.js';

/**
 * Resolve a TopoRef against a shape, by provenance where possible and fingerprint
 * otherwise. Pure: it sees only fingerprints and history maps, never geometry, so every
 * branch is unit-testable without OCCT.
 */

/** One operation between the reference's origin and the shape being resolved against. */
export interface HistoryStep {
  readonly featureId: FeatureId;
  /** Which of that operation's inputs the entity arrived through. */
  readonly inputIndex: number;
  readonly history: ShapeHistory | null;
}

/** Above this, the original index is trusted without a full search. */
const INDEX_FAST_PATH = 0.97;

/**
 * Provenance is exact only when it says something. A traced index is still checked
 * against the fingerprint before being accepted, because a history map can be right
 * about "this became that" while the surrounding shape has renumbered underneath it.
 */
const PROVENANCE_VERIFY = 0.5;

/**
 * @param chain operations between the origin feature's output and the target shape,
 *        oldest first. Empty when the reference was picked on this very shape.
 */
export function resolveTopoRef(
  ref: TopoRef,
  target: ShapeDescription,
  chain: readonly HistoryStep[] = [],
  thresholds: MatchThresholds = DEFAULT_THRESHOLDS,
): Resolution {
  const candidates = entitiesOfKind(target, ref.kind);

  // --- provenance, when there is a chain to replay
  if (chain.length > 0) {
    const traced = traceThroughHistory(ref, chain);
    if (traced.length === 1) {
      const entity = candidates.find((c) => c.index === traced[0]);
      // Verify before trusting. Provenance can be right that an entity survived while
      // being wrong about where it landed, and an unverified hit here is precisely the
      // silent misplacement this whole subsystem exists to prevent.
      const score = entity ? scoreMatch(ref.fingerprint, entity) : null;
      if (entity && score !== null && score >= PROVENANCE_VERIFY) {
        return { ok: true, index: entity.index, method: 'provenance', confidence: score };
      }
    }
    if (traced.length > 1) {
      // The entity split — one edge became several. Genuinely ambiguous: which piece did
      // the user mean? Fall through to fingerprinting, which may still pick one out.
      const narrowed = candidates.filter((c) => traced.includes(c.index));
      if (narrowed.length > 0) {
        const scoped = bestMatch(ref.fingerprint, narrowed, thresholds);
        if (scoped.ok) return { ...scoped, method: 'provenance', confidence: scoped.confidence };
      }
    }
    if (isDeleted(ref, chain)) {
      return {
        ok: false,
        reason: `the referenced ${ref.kind} was removed by a later feature`,
        candidates: [],
      };
    }
  }

  // --- index fast path: nothing moved, so the original index still fits perfectly
  const atOriginalIndex = candidates.find((c) => c.index === ref.origin.index);
  if (atOriginalIndex) {
    const score = scoreMatch(ref.fingerprint, atOriginalIndex);
    if (score !== null && score >= INDEX_FAST_PATH) {
      return { ok: true, index: atOriginalIndex.index, method: 'index', confidence: score };
    }
  }

  // --- fingerprint search
  return bestMatch(ref.fingerprint, candidates, thresholds);
}

function entitiesOfKind(description: ShapeDescription, kind: TopoRef['kind']) {
  return kind === 'face' ? description.faces
    : kind === 'edge' ? description.edges
    : description.vertices;
}

/**
 * Follow an index forward through a chain of operations.
 *
 * Returns every index the entity became, or an empty array when the trail is
 * INCONCLUSIVE — which is emphatically not the same as "unchanged".
 *
 * OCCT's history records only what an operation *changed*. It is tempting to read a
 * missing entry as "this entity is still itself, at the same index", and that is wrong:
 * an operation can leave an edge geometrically untouched while the shape it belongs to
 * renumbers everything. Carrying the old index forward on that assumption resolves to a
 * real, valid, completely unrelated edge — a silent misplacement, the exact failure this
 * subsystem exists to prevent. So an absent mapping ends the trail and hands the
 * question to fingerprinting, which asks "which entity looks like the one I picked?"
 * rather than "which entity happens to sit at that number?".
 */
function traceThroughHistory(ref: TopoRef, chain: readonly HistoryStep[]): number[] {
  let current = [ref.origin.index];

  for (const step of chain) {
    const input = step.history?.inputs[step.inputIndex];
    if (!input) return []; // no history at all: inconclusive

    const next: number[] = [];
    for (const index of current) {
      const mapped = ref.kind === 'face'
        ? input.modifiedFaces.get(index)
        : ref.kind === 'edge'
          ? input.modifiedEdges.get(index)
          : undefined;
      if (mapped && mapped.length > 0) next.push(...mapped);
    }
    if (next.length === 0) return []; // nothing said about it: inconclusive
    current = [...new Set(next)];
  }
  return current;
}

function isDeletedAtStep(
  ref: TopoRef,
  input: ShapeHistory['inputs'][number],
  index: number,
): boolean {
  return ref.kind === 'face'
    ? input.deletedFaces.includes(index)
    : ref.kind === 'edge'
      ? input.deletedEdges.includes(index)
      : false;
}

function isDeleted(ref: TopoRef, chain: readonly HistoryStep[]): boolean {
  for (const step of chain) {
    const input = step.history?.inputs[step.inputIndex];
    if (input && isDeletedAtStep(ref, input, ref.origin.index)) return true;
  }
  return false;
}

/** Mint a reference from a pick on a shape. */
export function captureTopoRef(
  featureId: FeatureId,
  kind: TopoRef['kind'],
  index: number,
  description: ShapeDescription,
): TopoRef | null {
  const entity = entitiesOfKind(description, kind).find((e) => e.index === index);
  if (!entity) return null;
  return { kind, origin: { featureId, index }, fingerprint: entity };
}
