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
  /** Bodies left on screen as they were, because their geometry did not change. */
  readonly reusedMeshes: number;
  /**
   * This run was superseded and stopped early; its bodies mean nothing.
   *
   * The caller must not treat it as the current picture of the model — in particular it
   * must not swap in handles or clear bodies from it.
   */
  readonly abandoned: boolean;
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

/**
 * The leaves that are solids.
 *
 * A sketch nobody has extruded yet is a leaf too, but it is a face, not a body: it
 * cannot be combined, and exporting it writes a zero-thickness surface into the STL.
 * Anything that counts or exports bodies wants this list, not `leafFeatures`.
 */
export function bodyFeatures(doc: Document): FeatureId[] {
  return leafFeatures(doc).filter((id) => doc.feature(id)?.type !== 'sketch');
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

/**
 * Mint durable references for several picked sub-shapes of one feature.
 *
 * Kind is a parameter rather than a second near-identical function because every
 * face-consuming feature (shell) needs exactly what the edge-consuming ones (fillet,
 * chamfer) need.
 */
export async function captureRefs(
  kernel: KernelPort,
  feature: FeatureId,
  kind: 'face' | 'edge' | 'vertex',
  indices: readonly number[],
  handleFor: (feature: FeatureId) => string | null,
): Promise<TopoRef[]> {
  const handle = handleFor(feature);
  if (!handle) return [];
  const description = await kernel.describeShape(handle as never);
  return indices
    .map((index) => captureTopoRef(feature, kind, index, description))
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
  /** True once a newer rebuild has started, so this one should stop. */
  superseded?: () => boolean,
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
    return { result, rebuildMs, tessellateMs: 0, bodies: [], errors, abandoned: true, reusedMeshes: 0 };
  }

  // Tessellate EVERY leaf, each under its own feature id. Reusing one body id would make
  // each new shape replace the last, which is what made a second primitive appear to do
  // nothing at all.
  //
  // But not every leaf every time: a body whose handle has not changed since it was
  // last meshed is already on screen, and meshing it again is the largest cost of a
  // rebuild that touched something else. Handles are never reused by the kernel, so
  // (body, handle) identifies a mesh exactly.
  const startedTessellate = performance.now();
  const bodies: TessellatedBody[] = [];
  const live = new Set<string>();
  const meshed = meshedHandles(viewer);
  let reusedMeshes = 0;

  for (const id of leafFeatures(doc)) {
    if (hide && id === hide) continue;
    const handle = result.states.get(id)?.handle;
    if (!handle) continue;

    const existing = viewer.bodies.get(id as string);
    if (existing && meshed.get(id as string) === handle) {
      bodies.push(existing.data);
      live.add(id as string);
      reusedMeshes++;
      continue;
    }

    // Bail if a newer rebuild has started. Tessellation happens OUTSIDE the document's
    // recompute, so a superseded run could still reach for a handle the newer run's
    // cache eviction had already freed — the kernel then threw "unknown shape handle",
    // and the app sat on "rebuilding…" for good. Checked per body, because tessellating
    // a large part takes long enough for a newer edit to land mid-loop.
    if (superseded?.()) {
      return { result, rebuildMs, tessellateMs: 0, bodies: [], errors, abandoned: true, reusedMeshes };
    }

    const body = await kernel.tessellate(handle, id as unknown as BodyId, DISPLAY_QUALITY);
    bodies.push(body);
    live.add(id as string);
    viewer.setBody(body);
    meshed.set(id as string, handle);
  }
  const tessellateMs = performance.now() - startedTessellate;

  // Drop bodies whose feature is gone or no longer a leaf — otherwise a cut leaves its
  // two inputs on screen, overlapping the result.
  for (const bodyId of [...viewer.bodies.keys()]) {
    if (!live.has(bodyId)) { viewer.removeBody(bodyId); meshed.delete(bodyId); }
  }

  return { result, rebuildMs, tessellateMs, bodies, errors, abandoned: false, reusedMeshes };
}

/** Which kernel handle each on-screen body was meshed from, per viewer. */
const MESHED = new WeakMap<Viewer, Map<string, string>>();
function meshedHandles(viewer: Viewer): Map<string, string> {
  let map = MESHED.get(viewer);
  if (!map) { map = new Map(); MESHED.set(viewer, map); }
  return map;
}

/** The on-screen body a feature ends up in: itself if it is a leaf, else whatever
 *  consumed it, followed downstream. Null when nothing on screen carries it. */
export function bodyShowing(doc: Document, id: FeatureId): FeatureId | null {
  const leaves = new Set(bodyFeatures(doc));
  let current: FeatureId | null = id;
  for (let hops = 0; current && hops < doc.features.length; hops++) {
    if (leaves.has(current)) return current;
    const target: FeatureId = current;
    const consumer = doc.features.find((f) => {
      const definition = doc.registry.get(f.type);
      const optional = new Set(definition?.optionalShapeInputs ?? []);
      return Object.entries(f.inputs).some(([role, input]) => input === target && !optional.has(role));
    });
    current = consumer?.id ?? null;
  }
  return null;
}

/** Roll a rebuild up into the numbers the status bar shows. */
export function summarise(result: RebuildReport) {
  const faces = result.bodies.reduce((n, b) => n + b.faceCount, 0);
  const triangles = result.bodies.reduce((n, b) => n + b.indices.length / 3, 0);
  return {
    rebuildMs: result.rebuildMs,
    meshMs: result.bodies.length > 0 ? result.tessellateMs : null,
    triangles: result.bodies.length > 0 ? triangles : null,
    faces: result.bodies.length > 0 ? faces : null,
    cached: result.result.reused.length,
    error: result.errors[0] ?? null,
  };
}
