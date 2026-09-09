import type { FeatureId, KernelPort, ShapeHandle } from '@cardstock/types';
import { evaluate, parse } from '../params/expression.js';
import type { ParameterTable } from '../params/parameters.js';
import type { Feature, FeatureRegistry } from '../features/feature.js';
import { buildGraph } from './build-graph.js';
import { contentHash } from './hash.js';
import { isFeatureNode, nodeName } from './dependency-graph.js';

/**
 * The recompute engine.
 *
 * Three properties matter, and each is a deliberate design choice:
 *
 * 1. Only the dirty branch rebuilds. Editing a parameter marks its dependents dirty
 *    transitively; everything else keeps its previous result.
 * 2. Results are content-addressed. A feature's output is cached under a hash of its
 *    type, resolved values, selections and INPUT HASHES, so scrubbing a parameter back
 *    and forth is free and undo/redo is near-instant.
 * 3. Failure is local. A feature that fails does not halt the rebuild: it falls back to
 *    its primary input so downstream features carry on, and it is flagged rather than
 *    silently skipped. You always have something on screen and a precise error to fix.
 */

export type FeatureStatusKind = 'ok' | 'error' | 'blocked' | 'suppressed';

export interface FeatureState {
  readonly id: FeatureId;
  readonly status: FeatureStatusKind;
  /** The shape this feature contributes downstream. Null when nothing could be produced. */
  readonly handle: ShapeHandle | null;
  readonly hash: string | null;
  readonly message?: string;
  /** True when the result came from the cache rather than the kernel. */
  readonly cached: boolean;
  /** True when `handle` is the passthrough input rather than this feature's own output. */
  readonly fellBack: boolean;
}

export interface RecomputeResult {
  readonly states: ReadonlyMap<FeatureId, FeatureState>;
  /** Features visited this run, in dependency order. */
  readonly order: readonly FeatureId[];
  /** Features that actually invoked the kernel. */
  readonly computed: readonly FeatureId[];
  /** Features served from the content cache. */
  readonly reused: readonly FeatureId[];
  /** Features left untouched because they were not dirty. */
  readonly skipped: readonly FeatureId[];
  readonly parameterErrors: ReadonlyMap<string, string>;
  /** Features caught in a dependency cycle. */
  readonly cyclic: readonly FeatureId[];
  readonly cancelled: boolean;
}

export class CancellationToken {
  #cancelled = false;
  get cancelled(): boolean { return this.#cancelled; }
  cancel(): void { this.#cancelled = true; }
}

export interface RecomputeOptions {
  /**
   * Nodes known to have changed, as graph node ids. When omitted everything is
   * considered dirty — the correct behaviour for a first run or a document load.
   */
  readonly changed?: Iterable<string>;
  readonly token?: CancellationToken;
}

export class RecomputeEngine {
  readonly #cache = new Map<string, ShapeHandle>();
  /** Insertion-ordered hashes, for LRU-ish eviction. */
  #previous: Map<FeatureId, FeatureState> | null = null;

  constructor(
    private readonly kernel: KernelPort,
    private readonly registry: FeatureRegistry,
  ) {}

  get cacheSize(): number { return this.#cache.size; }
  get lastStates(): ReadonlyMap<FeatureId, FeatureState> | null { return this.#previous; }

  /** Forget cached geometry and previous results. */
  async reset(): Promise<void> {
    for (const handle of this.#cache.values()) {
      await this.kernel.release(handle).catch(() => {});
    }
    this.#cache.clear();
    this.#previous = null;
  }

  async recompute(
    params: ParameterTable,
    features: readonly Feature[],
    options: RecomputeOptions = {},
  ): Promise<RecomputeResult> {
    const token = options.token ?? new CancellationToken();
    const graph = buildGraph(params, features);
    const { order, cyclic } = graph.topologicalOrder();

    const byId = new Map(features.map((f) => [f.id, f]));
    const previous = this.#previous;
    const dirty = options.changed && previous
      ? graph.dirtyFrom(options.changed)
      : null; // null means "everything"

    const states = new Map<FeatureId, FeatureState>();
    const visited: FeatureId[] = [];
    const computed: FeatureId[] = [];
    const reused: FeatureId[] = [];
    const skipped: FeatureId[] = [];

    const scope = params.scope();
    const cyclicFeatures = cyclic.filter(isFeatureNode).map((n) => nodeName(n) as FeatureId);
    for (const id of cyclicFeatures) {
      states.set(id, {
        id, status: 'error', handle: null, hash: null, cached: false, fellBack: false,
        message: 'circular dependency between features',
      });
    }

    for (const node of order) {
      if (!isFeatureNode(node)) continue;
      const id = nodeName(node) as FeatureId;
      const feature = byId.get(id);
      if (!feature) continue;

      // Unchanged branch: carry the previous result forward untouched.
      if (dirty && !dirty.has(node)) {
        const prior = previous?.get(id);
        if (prior) {
          states.set(id, prior);
          skipped.push(id);
          continue;
        }
      }

      visited.push(id);

      if (token.cancelled) {
        return this.#finish(states, visited, computed, reused, skipped, params, cyclicFeatures, true);
      }

      const state = await this.#computeOne(feature, states, scope, computed, reused);
      states.set(id, state);
    }

    return this.#finish(states, visited, computed, reused, skipped, params, cyclicFeatures, false);
  }

  async #computeOne(
    feature: Feature,
    states: Map<FeatureId, FeatureState>,
    scope: (n: string) => number | undefined,
    computed: FeatureId[],
    reused: FeatureId[],
  ): Promise<FeatureState> {
    const definition = this.registry.get(feature.type);
    if (!definition) {
      return {
        id: feature.id, status: 'error', handle: null, hash: null, cached: false,
        fellBack: false, message: `unknown feature type "${feature.type}"`,
      };
    }

    // --- resolve shape inputs
    const shapes: Record<string, ShapeHandle> = {};
    const inputHashes: Record<string, string | null> = {};
    for (const role of definition.shapeInputs) {
      const upstreamId = feature.inputs[role];
      if (upstreamId === undefined) continue;
      const upstream = states.get(upstreamId as FeatureId);
      if (upstream?.handle) {
        shapes[role] = upstream.handle;
        inputHashes[role] = upstream.hash;
      }
    }

    const primary = definition.primaryInput ? shapes[definition.primaryInput] ?? null : null;
    const primaryHash = definition.primaryInput
      ? inputHashes[definition.primaryInput] ?? null
      : null;

    // A feature whose required input never materialised cannot even fall back.
    const missing = definition.shapeInputs.filter((r) => shapes[r] === undefined);
    if (missing.length > 0 && definition.shapeInputs.length > 0) {
      if (!primary) {
        return {
          id: feature.id, status: 'blocked', handle: null, hash: null, cached: false,
          fellBack: false,
          message: `input ${missing.map((m) => `"${m}"`).join(', ')} is unavailable`,
        };
      }
    }

    // --- suppressed features pass their primary input straight through
    if (feature.suppressed) {
      return {
        id: feature.id, status: 'suppressed', handle: primary, hash: primaryHash,
        cached: false, fellBack: true,
      };
    }

    // --- evaluate value expressions
    const values: Record<string, number> = {};
    for (const [key, expression] of Object.entries(feature.values)) {
      try {
        values[key] = evaluate(parse(expression), scope);
      } catch (e) {
        return {
          id: feature.id, status: 'error', handle: primary, hash: primaryHash,
          cached: false, fellBack: primary !== null,
          message: `${key}: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    }

    const selections = (feature.selections ?? {}) as Record<string, readonly number[]>;

    // --- content hash: same inputs, same geometry, so reuse it
    const hash = contentHash({
      type: feature.type,
      values,
      selections,
      inputs: inputHashes,
    });

    const hit = this.#cache.get(hash);
    if (hit) {
      reused.push(feature.id);
      return { id: feature.id, status: 'ok', handle: hit, hash, cached: true, fellBack: false };
    }

    // --- actually build it
    try {
      const result = await definition.compute({
        kernel: this.kernel, feature, values, shapes, selections,
      });
      computed.push(feature.id);
      this.#cache.set(hash, result.handle);
      return { id: feature.id, status: 'ok', handle: result.handle, hash, cached: false, fellBack: false };
    } catch (e) {
      // Local failure: keep the last good shape flowing downstream so the rest of the
      // model still builds, and flag this feature precisely.
      return {
        id: feature.id, status: 'error', handle: primary, hash: primaryHash,
        cached: false, fellBack: primary !== null,
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }

  #finish(
    states: Map<FeatureId, FeatureState>,
    order: FeatureId[],
    computed: FeatureId[],
    reused: FeatureId[],
    skipped: FeatureId[],
    params: ParameterTable,
    cyclic: FeatureId[],
    cancelled: boolean,
  ): RecomputeResult {
    if (!cancelled) this.#previous = states;
    return {
      states, order, computed, reused, skipped,
      parameterErrors: params.errors(),
      cyclic,
      cancelled,
    };
  }

  /** Drop cached shapes no live feature state references. */
  async evict(keep: Iterable<string>, limit = 256): Promise<number> {
    const live = new Set(keep);
    let removed = 0;
    for (const [hash, handle] of [...this.#cache]) {
      if (this.#cache.size - removed <= limit) break;
      if (live.has(hash)) continue;
      this.#cache.delete(hash);
      await this.kernel.release(handle).catch(() => {});
      removed++;
    }
    return removed;
  }
}
