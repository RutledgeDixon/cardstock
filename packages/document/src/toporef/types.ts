import type { EntityFingerprint, EntityKind, FeatureId } from '@cardstock/types';

/**
 * A durable reference to a topological entity.
 *
 * Two mechanisms, because there are two problems (docs/toponaming.md):
 *
 * - `origin` supports PROVENANCE replay, for when the entity was picked on one feature's
 *   output but is needed against a downstream feature's output.
 * - `fingerprint` supports RE-IDENTIFICATION, for when the origin feature itself rebuilt
 *   with different parameters. Provenance cannot help there: a primitive rebuild has no
 *   history, the old and new shapes are simply unrelated objects.
 */
export interface TopoRef {
  readonly kind: Extract<EntityKind, 'face' | 'edge' | 'vertex'>;
  /** Where the entity was picked: which feature's output, and its index at that moment. */
  readonly origin: { readonly featureId: FeatureId; readonly index: number };
  /** What it looked like when picked. */
  readonly fingerprint: EntityFingerprint;
}

export type ResolutionMethod = 'provenance' | 'fingerprint' | 'index';

export type Resolution =
  | {
      readonly ok: true;
      readonly index: number;
      readonly method: ResolutionMethod;
      /** 0..1. Provenance resolves at 1. */
      readonly confidence: number;
    }
  | {
      readonly ok: false;
      readonly reason: string;
      /** Candidates that were close, for a repair UI to offer. */
      readonly candidates: readonly { index: number; score: number }[];
    };

/** Tuning for fingerprint matching. */
export interface MatchThresholds {
  /** Minimum score the winner must reach. */
  readonly accept: number;
  /** How far ahead of the runner-up the winner must be. */
  readonly margin: number;
}

export const DEFAULT_THRESHOLDS: MatchThresholds = { accept: 0.62, margin: 0.06 };
