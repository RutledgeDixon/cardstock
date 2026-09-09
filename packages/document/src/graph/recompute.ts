import type {
  FeatureId, KernelPort, ShapeDescription, ShapeHandle, ShapeHistory,
} from '@cardstock/types';
import type { SolverPort } from '@cardstock/types';
import { resolveTopoRef, type HistoryStep } from '../toporef/resolver.js';
import type { Sketch } from '../sketch/sketch.js';
import type { TopoRef } from '../toporef/types.js';
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
  /** How this feature's operation mapped its inputs onto its output. Drives naming. */
  readonly history?: ShapeHistory | null;
  /** References that could not be resolved, with the reason, for the repair UI. */
  readonly brokenReferences?: readonly { role: string; index: number; reason: string }[];
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

/** Used when no solver was supplied: sketch features then fail with a clear reason. */
const noSolver: SolverPort = {
  async solve() {
    throw new Error('no constraint solver is available');
  },
};

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
  /** Fingerprints per shape handle. Only fetched for features that reference topology. */
  readonly #descriptions = new Map<string, ShapeDescription>();
  /** Insertion-ordered hashes, for LRU-ish eviction. */
  #previous: Map<FeatureId, FeatureState> | null = null;

  /** Numeric parameter values for the run in progress, for sketch dimensions. */
  #parameterValues: Record<string, number> = {};

  constructor(
    private readonly kernel: KernelPort,
    readonly registry: FeatureRegistry,
    private readonly solver: SolverPort = noSolver,
    /** Looks up a sketch by id; supplied by the Document that owns them. */
    private readonly sketches?: (id: string) => Sketch | null,
  ) {}

  get cacheSize(): number { return this.#cache.size; }
  get lastStates(): ReadonlyMap<FeatureId, FeatureState> | null { return this.#previous; }

  /** Forget cached geometry and previous results. */
  async reset(): Promise<void> {
    for (const handle of this.#cache.values()) {
      await this.kernel.release(handle).catch(() => {});
    }
    this.#cache.clear();
    this.#descriptions.clear();
    this.#previous = null;
  }

  async #describe(handle: ShapeHandle): Promise<ShapeDescription> {
    const cached = this.#descriptions.get(handle);
    if (cached) return cached;
    const description = await this.kernel.describeShape(handle);
    this.#descriptions.set(handle, description);
    return description;
  }

  async recompute(
    params: ParameterTable,
    features: readonly Feature[],
    options: RecomputeOptions = {},
  ): Promise<RecomputeResult> {
    const token = options.token ?? new CancellationToken();
    const graph = buildGraph(params, features, this.sketches);
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
    // Snapshot parameter values once per run, for any sketch that names one.
    this.#parameterValues = {};
    for (const [name, value] of params.evaluateAll()) {
      if (value.ok) this.#parameterValues[name] = value.value;
    }
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

      const state = await this.#computeOne(feature, states, byId, scope, computed, reused);
      states.set(id, state);
    }

    return this.#finish(states, visited, computed, reused, skipped, params, cyclicFeatures, false);
  }

  async #computeOne(
    feature: Feature,
    states: Map<FeatureId, FeatureState>,
    allFeatures: ReadonlyMap<FeatureId, Feature>,
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
    const allRoles = [...definition.shapeInputs, ...(definition.optionalShapeInputs ?? [])];
    for (const role of allRoles) {
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
    //
    // Only the keys the definition declares as numeric. Anything else is a plain setting
    // — a fastener size like "M3", a hole style like "counterbore" — and evaluating it
    // as an expression would fail with "unknown parameter M3". Definitions read those
    // straight off feature.values.
    const numericKeys = new Set(definition.valueKeys);
    const values: Record<string, number> = {};
    for (const [key, expression] of Object.entries(feature.values)) {
      if (!numericKeys.has(key)) continue;
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

    // --- resolve topological references against the input shape
    const primaryRole = definition.primaryInput;
    const resolved: Record<string, number[]> = {};
    const broken: { role: string; index: number; reason: string }[] = [];
    const refRoles = Object.entries(feature.selections ?? {});

    if (refRoles.length > 0 && primaryRole && shapes[primaryRole]) {
      const description = await this.#describe(shapes[primaryRole]!);
      for (const [role, refs] of refRoles) {
        // A document is a file, so its selections are untrusted input. Malformed data
        // should say what is wrong, not surface as a TypeError from deep in the engine.
        if (!Array.isArray(refs)) {
          broken.push({ role, index: 0, reason: `selection "${role}" is not a list` });
          continue;
        }
        const indices: number[] = [];
        for (const [position, ref] of (refs as readonly TopoRef[]).entries()) {
          if (!ref || typeof ref !== 'object' || !('fingerprint' in ref)) {
            broken.push({ role, index: position, reason: `selection "${role}" is malformed` });
            continue;
          }
          const chain = buildHistoryChain(
            ref, feature, primaryRole, states, allFeatures, this.registry,
          );
          const outcome = resolveTopoRef(ref, description, chain);
          if (outcome.ok) indices.push(outcome.index);
          else broken.push({ role, index: position, reason: outcome.reason });
        }
        resolved[role] = indices;
      }
    }

    if (broken.length > 0) {
      // Never guess. A wrong fillet that looks plausible gets printed before anyone
      // notices; a refused one is fixed by re-picking in ten seconds.
      return {
        id: feature.id, status: 'error', handle: primary, hash: primaryHash,
        cached: false, fellBack: primary !== null, brokenReferences: broken,
        message: broken.length === 1
          ? broken[0]!.reason
          : `${broken.length} references could not be resolved`,
      };
    }

    const selections = resolved;

    // --- content hash: same inputs, same geometry, so reuse it. Hashing the RESOLVED
    // indices means a reference that re-resolves to where it was is a cache hit.
    //
    // A sketch feature has no values and no inputs, so without folding the sketch itself
    // in, every sketch hashes identically and the cache hands back whatever face was
    // built first — silently, for any edit at all.
    const sketch = feature.sketchId ? this.sketches?.(feature.sketchId) ?? null : null;
    const sketchHash = sketch
      ? contentHash({
          plane: sketch.plane,
          geometry: sketch.geometry,
          constraints: sketch.constraints,
          // The values its dimensions resolve to, not just their names.
          parameters: Object.fromEntries(
            sketch.referencedParameters().map((n) => [n, this.#parameterValues[n]]),
          ),
        })
      : null;

    const hash = contentHash({
      type: feature.type,
      values,
      // Raw values too, so a change to a non-numeric setting is not invisible to the
      // cache and served stale.
      settings: feature.values,
      selections,
      inputs: inputHashes,
      sketch: sketchHash,
    });

    const hit = this.#cache.get(hash);
    if (hit) {
      reused.push(feature.id);
      return { id: feature.id, status: 'ok', handle: hit, hash, cached: true, fellBack: false };
    }

    // --- actually build it
    try {
      const result = await definition.compute({
        kernel: this.kernel,
        solver: this.solver,
        sketch,
        parameters: this.#parameterValues,
        feature, values, shapes, selections,
      });
      computed.push(feature.id);
      this.#cache.set(hash, result.handle);
      return {
        id: feature.id, status: 'ok', handle: result.handle, hash,
        cached: false, fellBack: false, history: result.history ?? null,
      };
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

/**
 * The operations between a reference's origin and the shape it is being resolved
 * against, oldest first.
 *
 * Walks back up the primary-input chain from the consuming feature to the origin
 * feature, then reverses. An empty chain means the reference was picked on the very
 * shape now being resolved — the ordinary case, needing no provenance at all.
 */
function buildHistoryChain(
  ref: TopoRef,
  consumer: Feature,
  primaryRole: string,
  states: ReadonlyMap<FeatureId, FeatureState>,
  features: ReadonlyMap<FeatureId, Feature>,
  registry: FeatureRegistry,
): HistoryStep[] {
  const steps: HistoryStep[] = [];
  const seen = new Set<string>([consumer.id]);
  let currentId = consumer.inputs[primaryRole];

  while (currentId && currentId !== ref.origin.featureId && !seen.has(currentId)) {
    seen.add(currentId);
    const feature = features.get(currentId);
    const state = states.get(currentId);
    if (!feature || !state) break;

    const definition = registry.get(feature.type);
    const role = definition?.primaryInput;
    const inputIndex = role ? Math.max(0, definition!.shapeInputs.indexOf(role)) : 0;

    steps.push({ featureId: currentId, inputIndex, history: state.history ?? null });
    currentId = role ? feature.inputs[role] : undefined;
  }

  // Collected consumer-first; provenance replays origin-first.
  return steps.reverse();
}
