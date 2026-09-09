import type { FeatureId, TessellatedBody } from '@cardstock/types';
import { DISPLAY_QUALITY } from '@cardstock/types';
import type { Document, RecomputeResult } from '@cardstock/document';
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
  readonly body: TessellatedBody | null;
  readonly errors: readonly string[];
}

/**
 * The feature whose output is the visible part: the last one nothing else consumes.
 * With an explicit graph there can be several leaves; the last in tree order is the one
 * the user most recently built toward.
 */
export function terminalFeature(doc: Document): FeatureId | null {
  const consumed = new Set<string>();
  for (const feature of doc.features) {
    for (const input of Object.values(feature.inputs)) consumed.add(input as string);
  }
  const leaves = doc.features.filter((f) => !consumed.has(f.id as string));
  return (leaves.at(-1) ?? doc.features.at(-1))?.id ?? null;
}

export async function rebuild(
  doc: Document,
  kernel: KernelPort,
  viewer: Viewer,
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
    return { result, rebuildMs, tessellateMs: 0, body: null, errors };
  }

  const terminal = terminalFeature(doc);
  const handle = terminal ? result.states.get(terminal)?.handle : null;
  if (!handle) {
    return { result, rebuildMs, tessellateMs: 0, body: null, errors };
  }

  const startedTessellate = performance.now();
  const body = await kernel.tessellate(handle, 'part' as never, DISPLAY_QUALITY);
  const tessellateMs = performance.now() - startedTessellate;

  viewer.setBody(body);
  return { result, rebuildMs, tessellateMs, body, errors };
}
