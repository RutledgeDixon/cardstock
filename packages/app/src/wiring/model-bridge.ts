import type { BodyId, FeatureId, TessellatedBody } from '@cardstock/types';
import { DISPLAY_QUALITY } from '@cardstock/types';
import { captureTopoRef, type Document, type RecomputeResult, type TopoRef } from '@cardstock/document';
import type { KernelPort } from '@cardstock/types';
import type { Viewer } from '@cardstock/viewer';

/**
 * document -> kernel -> viewer.
 *
 * The one place the three layers meet. Rebuilds the model, tessellates whatever the
 * final feature produced, and hands the mesh to the viewer.
 */
export interface RebuildReport {
  readonly result: RecomputeResult;
  readonly rebuildMs: number;
  readonly tessellateMs: number;
  /** One per independent body currently on screen. */
  readonly bodies: readonly TessellatedBody[];
  readonly errors: readonly string[];
}

/**
 * Features whose output nothing else consumes — every independent body in the model.
 *
 * With an explicit dependency graph there can be several at once, and that is the normal
 * way to work: you make a box and a cylinder, THEN cut one with the other. Showing only
 * the last of them makes the others vanish the moment a second is added.
 */
export function leafFeatures(doc: Document): FeatureId[] {
  const consumed = new Set<string>();
  for (const feature of doc.features) {
    const definition = doc.registry.get(feature.type);
    // OPTIONAL inputs are references, not consumption. A sketch names the body it sits
    // on so its plane can be resolved, but it does not absorb it — treating that as
    // consumption makes the body vanish the moment you sketch on it.
    const optional = new Set(definition?.optionalShapeInputs ?? []);
    for (const [role, input] of Object.entries(feature.inputs)) {
      if (!optional.has(role)) consumed.add(input as string);
    }
  }
  const leaves = doc.features.filter((f) => !consumed.has(f.id as string));
  return leaves.length > 0
    ? leaves.map((f) => f.id)
    : doc.features.slice(-1).map((f) => f.id);
}

/** The body a new operation should default to acting on: the most recent leaf. */
export function terminalFeature(doc: Document): FeatureId | null {
  return leafFeatures(doc).at(-1) ?? null;
}

/**
 * Mint durable references for edges the user picked in the viewport.
 *
 * The viewer hands back tessellation indices, which are only valid until the next
 * rebuild. This turns them into TopoRefs, which are not. See docs/toponaming.md.
 */
/** Mint a durable reference for one picked face, e.g. a sketch plane. */
export async function captureFaceRef(
  kernel: KernelPort,
  feature: FeatureId,
  index: number,
  handleFor: (feature: FeatureId) => string | null,
): Promise<TopoRef | null> {
  const handle = handleFor(feature);
  if (!handle) return null;
  const description = await kernel.describeShape(handle as never);
  return captureTopoRef(feature, 'face', index, description);
}

export async function captureEdgeRefs(
  doc: Document,
  kernel: KernelPort,
  feature: FeatureId,
  indices: readonly number[],
  handleFor: (feature: FeatureId) => string | null,
): Promise<TopoRef[]> {
  const handle = handleFor(feature);
  if (!handle) return [];
  const description = await kernel.describeShape(handle as never);
  return indices
    .map((index) => captureTopoRef(feature, 'edge', index, description))
    .filter((ref): ref is TopoRef => ref !== null);
}

export async function rebuild(
  doc: Document,
  kernel: KernelPort,
  viewer: Viewer,
  /**
   * A feature to leave out of the rendered bodies.
   *
   * Used for the sketch currently open for editing: its face is coplanar with whatever
   * it was drawn on, so rendering both z-fights, and SketchView is already drawing the
   * sketch in a form you can actually edit.
   */
  hide?: FeatureId | null,
): Promise<RebuildReport> {
  const startedRebuild = performance.now();
  const result = await doc.recompute();
  const rebuildMs = performance.now() - startedRebuild;

  const errors: string[] = [];
  for (const [name, message] of result.parameterErrors) errors.push(`${name}: ${message}`);
  for (const state of result.states.values()) {
    if (state.message) {
      const feature = doc.feature(state.id);
      errors.push(`${feature?.name || state.id}: ${state.message}`);
    }
  }

  if (result.cancelled) {
    return { result, rebuildMs, tessellateMs: 0, bodies: [], errors };
  }

  // Tessellate EVERY leaf, each under its own feature id. Reusing one body id would make
  // each new shape replace the last, which is what made a second primitive appear to do
  // nothing at all.
  const startedTessellate = performance.now();
  const bodies: TessellatedBody[] = [];
  const live = new Set<string>();

  for (const id of leafFeatures(doc)) {
    if (hide && id === hide) continue;
    const handle = result.states.get(id)?.handle;
    if (!handle) continue;
    const body = await kernel.tessellate(handle, id as unknown as BodyId, DISPLAY_QUALITY);
    bodies.push(body);
    live.add(id as string);
    viewer.setBody(body);
  }
  const tessellateMs = performance.now() - startedTessellate;

  // Drop bodies whose feature is gone or no longer a leaf — otherwise a cut leaves its
  // two inputs on screen, overlapping the result.
  for (const bodyId of [...viewer.bodies.keys()]) {
    if (!live.has(bodyId)) viewer.removeBody(bodyId);
  }

  return { result, rebuildMs, tessellateMs, bodies, errors };
}
