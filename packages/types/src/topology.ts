import type { BodyId } from './ids.js';

/** What kind of topological entity the user is pointing at. */
export type EntityKind = 'face' | 'edge' | 'vertex' | 'body';

/** The four selectable kinds, in the order the Tab key cycles them. */
export const ENTITY_KINDS = ['face', 'edge', 'vertex', 'body'] as const;

/**
 * A reference to one topological entity of a tessellated body.
 *
 * `index` is an index into the *current* tessellation, valid only until the body is
 * rebuilt. It is a transient handle for picking and highlighting — NOT a durable
 * reference. Durable references are `TopoRef` (Phase 4), resolved through OCCT
 * provenance; see docs/adr/0001-geometry-kernel.md.
 */
export interface EntityRef {
  readonly bodyId: BodyId;
  readonly kind: EntityKind;
  readonly index: number;
}

export function entityRefEquals(a: EntityRef | null, b: EntityRef | null): boolean {
  if (a === null || b === null) return a === b;
  return a.bodyId === b.bodyId && a.kind === b.kind && a.index === b.index;
}

/** Stable string key, for Sets and Maps. */
export const entityRefKey = (r: EntityRef): string => `${r.bodyId}:${r.kind}:${r.index}`;
