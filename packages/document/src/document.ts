import { type FeatureId, asFeatureId, type KernelPort, type SolverPort } from '@cardstock/types';
import { Sketch, type SketchPlane } from './sketch/sketch.js';
import { ParameterTable, type Parameter } from './params/parameters.js';
import type { FeatureRegistry } from './features/feature.js';
import { type Feature } from './features/feature.js';
import { createBuiltinRegistry } from './features/builtins.js';
import { RecomputeEngine, type RecomputeResult, CancellationToken } from './graph/recompute.js';
import { buildGraph } from './graph/build-graph.js';
import { featureNode, paramNode, type NodeId } from './graph/dependency-graph.js';
import { History } from './undo/history.js';
import {
  CURRENT_SCHEMA_VERSION, type DocumentFile, type DocumentMeta, migrate,
} from './serialize/schema.js';

/**
 * A CARDstock part document: parameters, an ordered feature list, and the engine that
 * turns them into geometry.
 *
 * Note that feature ORDER is presentational. Dependencies are explicit — a feature names
 * its inputs by id — so reordering the list changes what you see in the tree, not what
 * depends on what. That keeps the rebuild graph honest and makes reordering safe, unlike
 * history-position-based CAD where moving a feature silently rebinds it.
 */

export interface DocumentSnapshot {
  readonly parameters: readonly Parameter[];
  readonly features: readonly Feature[];
  readonly meta: DocumentMeta;
}

/** One input rebinding performed by a reorder. */
export interface RewireEdit {
  readonly id: FeatureId;
  readonly role: string;
  readonly from: FeatureId;
  to: FeatureId;
}

export interface ReorderResult {
  readonly ok: boolean;
  /** Present when the move was refused, phrased for the user. */
  readonly reason?: string;
  readonly rewired: readonly RewireEdit[];
}

export interface EditOptions {
  /** Shown in the undo menu. */
  readonly label?: string;
  /** Edits sharing a key in quick succession collapse into one undo step. */
  readonly coalesceKey?: string | null;
}

export class Document {
  readonly parameters = new ParameterTable();
  readonly registry: FeatureRegistry;
  readonly engine: RecomputeEngine;

  #features: Feature[] = [];
  #history = new History<DocumentSnapshot>();
  #dirty = new Set<NodeId>();
  #everRecomputed = false;
  #running: CancellationToken | null = null;
  #idCounter = 0;
  #meta: DocumentMeta;

  /**
   * Cached shapes retained beyond those currently in use.
   *
   * Deep enough that undo and parameter scrubbing stay instant, shallow enough that a
   * long session does not grow without bound.
   */
  cacheLimit = 128;

  /** Sketches, keyed by id. Features reference one via `sketchId`. */
  readonly sketches = new Map<string, Sketch>();
  #nextSketchId = 0;

  constructor(
    kernel: KernelPort,
    registry: FeatureRegistry = createBuiltinRegistry(),
    solver?: SolverPort,
  ) {
    this.registry = registry;
    this.engine = new RecomputeEngine(
      kernel, registry, solver, (id) => this.sketches.get(id) ?? null,
    );
    const now = new Date().toISOString();
    this.#meta = {
      name: 'Untitled', created: now, modified: now, units: 'mm', application: 'CARDstock',
    };
  }

  // ------------------------------------------------------------------ reading
  get features(): readonly Feature[] { return this.#features; }
  get meta(): DocumentMeta { return this.#meta; }
  feature(id: FeatureId): Feature | undefined { return this.#features.find((f) => f.id === id); }
  get canUndo(): boolean { return this.#history.canUndo; }
  get canRedo(): boolean { return this.#history.canRedo; }
  get undoLabel(): string | null { return this.#history.undoLabel; }
  get redoLabel(): string | null { return this.#history.redoLabel; }

  /** Fresh id, unique within this document. */
  newFeatureId(prefix = 'f'): FeatureId {
    let id: string;
    do { id = `${prefix}${++this.#idCounter}`; } while (this.#features.some((f) => f.id === id));
    return asFeatureId(id);
  }

  snapshot(): DocumentSnapshot {
    return {
      parameters: this.parameters.all().map((p) => ({ ...p })),
      features: this.#features.map((f) => structuredClone(f)),
      meta: { ...this.#meta },
    };
  }

  // ------------------------------------------------------------------ editing
  #beginEdit(opts: EditOptions, defaultLabel: string): void {
    this.#history.record(this.snapshot(), opts.label ?? defaultLabel, opts.coalesceKey ?? null);
    this.#meta = { ...this.#meta, modified: new Date().toISOString() };
  }

  #markDirty(node: NodeId): void { this.#dirty.add(node); }

  /** Dependents of a node, computed against the CURRENT graph (call before removing). */
  #markDependentsDirty(node: NodeId): void {
    const graph = buildGraph(this.parameters, this.#features, (id) => this.sketches.get(id) ?? null);
    for (const n of graph.dirtyFrom([node])) this.#dirty.add(n);
  }

  setParameter(param: Parameter, opts: EditOptions = {}): string | null {
    this.#beginEdit(opts, `Set ${param.name}`);
    const error = this.parameters.set(param);
    if (error) return error;
    this.#markDirty(paramNode(param.name));
    return null;
  }

  removeParameter(name: string, opts: EditOptions = {}): boolean {
    if (!this.parameters.has(name)) return false;
    this.#beginEdit(opts, `Delete ${name}`);
    this.#markDependentsDirty(paramNode(name));
    return this.parameters.remove(name);
  }

  addFeature(feature: Feature, index?: number, opts: EditOptions = {}): Feature {
    this.#beginEdit(opts, `Add ${feature.name || feature.type}`);
    const at = index ?? this.#features.length;
    this.#features.splice(at, 0, feature);
    this.#markDirty(featureNode(feature.id));
    return feature;
  }

  updateFeature(
    id: FeatureId,
    patch: Partial<Omit<Feature, 'id'>>,
    opts: EditOptions = {},
  ): Feature | null {
    const index = this.#features.findIndex((f) => f.id === id);
    if (index < 0) return null;
    const existing = this.#features[index]!;
    this.#beginEdit(opts, `Edit ${existing.name || existing.type}`);
    const updated: Feature = {
      ...existing,
      ...patch,
      values: { ...existing.values, ...(patch.values ?? {}) },
      inputs: { ...existing.inputs, ...(patch.inputs ?? {}) },
      selections: { ...(existing.selections ?? {}), ...(patch.selections ?? {}) },
      id: existing.id,
    };
    this.#features[index] = updated;
    this.#markDirty(featureNode(id));
    return updated;
  }

  removeFeature(id: FeatureId, opts: EditOptions = {}): boolean {
    const index = this.#features.findIndex((f) => f.id === id);
    if (index < 0) return false;
    this.#beginEdit(opts, `Delete ${this.#features[index]!.name || 'feature'}`);
    this.#markDependentsDirty(featureNode(id));
    this.#features.splice(index, 1);
    return true;
  }

  /**
   * Move a feature in the tree, rewiring the primary-input chain to match.
   *
   * Dragging a fillet above a cut performs the edit you meant: the fillet takes the
   * cut's input, and the cut takes the fillet. Same visible behaviour as SolidWorks, but
   * the rebinding is an explicit recorded edit rather than an emergent side effect of an
   * array index — so it undoes as one step, Phase 4 can see the references change and
   * try to re-resolve selections, and an impossible move is refused with a reason
   * instead of silently producing a wrong part.
   *
   * Only the PRIMARY input chain is rewired. Secondary inputs (a boolean's tool) keep
   * their bindings, because "which solid does this cut with" is not something a drag in
   * a list can express unambiguously.
   */
  moveFeature(id: FeatureId, toIndex: number, opts: EditOptions = {}): ReorderResult {
    const from = this.#features.findIndex((f) => f.id === id);
    if (from < 0) return { ok: false, reason: 'no such feature', rewired: [] };
    if (toIndex < 0 || toIndex >= this.#features.length) {
      return { ok: false, reason: 'target position is outside the tree', rewired: [] };
    }
    if (from === toIndex) return { ok: true, rewired: [] };

    const moved = this.#features[from]!;
    const definition = this.registry.get(moved.type);
    const primaryRole = definition?.primaryInput;

    // The order the tree would end up in.
    const reordered = [...this.#features];
    reordered.splice(from, 1);
    reordered.splice(toIndex, 0, moved);

    // A root feature (a box, a cylinder) consumes nothing, so there is no chain to
    // splice — the move is purely organisational and always safe.
    const plan = (!primaryRole || moved.inputs[primaryRole] === undefined)
      ? { ok: true as const, rewired: [] as RewireEdit[] }   // a root consumes nothing
      : this.#planRewire(moved, primaryRole, reordered);
    if (!plan.ok) return plan;

    const unreadable = this.#orderIsReadable(reordered, plan.rewired);
    if (unreadable) return { ok: false, reason: unreadable, rewired: [] };

    this.#beginEdit(opts, `Move ${moved.name || moved.type}`);
    this.#features = reordered;
    for (const edit of plan.rewired) {
      const index = this.#features.findIndex((f) => f.id === edit.id);
      if (index < 0) continue;
      const target = this.#features[index]!;
      this.#features[index] = {
        ...target,
        inputs: { ...target.inputs, [edit.role]: edit.to },
      };
      this.#markDirty(featureNode(edit.id));
    }
    this.#markDirty(featureNode(moved.id));
    return plan;
  }

  /**
   * Work out the input rebindings a reorder implies, or why it cannot be done.
   *
   * Modelled as a linked-list splice on the PRIMARY CHAIN rather than on the raw feature
   * list. That distinction matters: in `Box, Drill, Hole, Round` the cylinder sits
   * between the box and the cut in the list, but it is a boolean *tool*, not a step in
   * the chain. Splicing against list neighbours would hand the fillet a cylinder to
   * operate on. Splicing against the chain skips side inputs, and being a chain, cannot
   * produce a cycle.
   */
  #planRewire(
    moved: Feature,
    primaryRole: string,
    reordered: readonly Feature[],
  ): ReorderResult {
    const chain = this.#primaryChain(moved);
    const others = chain.filter((f) => f.id !== moved.id);

    // Where the moved feature lands within the chain, derived from where it landed in
    // the list: how many chain members now sit above it.
    const movedListIndex = reordered.findIndex((f) => f.id === moved.id);
    const insertAt = others.filter(
      (f) => reordered.findIndex((r) => r.id === f.id) < movedListIndex,
    ).length;

    if (insertAt === 0) {
      return {
        ok: false,
        reason: `"${moved.name || moved.type}" needs something above it to operate on`,
        rewired: [],
      };
    }

    const newChain = [...others];
    newChain.splice(insertAt, 0, moved);

    // Re-link consecutive pairs. Anything already correct produces no edit.
    const rewired: RewireEdit[] = [];
    for (let i = 1; i < newChain.length; i++) {
      const feature = newChain[i]!;
      const role = this.registry.get(feature.type)?.primaryInput;
      if (!role) continue;
      const from = feature.inputs[role];
      const to = newChain[i - 1]!.id;
      if (from !== undefined && from !== to) rewired.push({ id: feature.id, role, from, to });
    }
    return { ok: true, rewired };
  }

  /**
   * The chain of features linked by primary inputs that `moved` belongs to, root first.
   *
   * Walking down stops at a fork: when two features both consume the same output as
   * their primary input there is no single chain, and a drag in a list cannot say which
   * branch was meant.
   */
  #primaryChain(moved: Feature): Feature[] {
    const primaryRoleOf = (f: Feature) => this.registry.get(f.type)?.primaryInput;
    const byId = new Map(this.#features.map((f) => [f.id as string, f]));

    const up: Feature[] = [];
    const seen = new Set<string>([moved.id]);
    let cursor: Feature | undefined = moved;
    while (cursor) {
      const role = primaryRoleOf(cursor);
      const parentId = role ? cursor.inputs[role] : undefined;
      if (!parentId || seen.has(parentId)) break;
      const parent: Feature | undefined = byId.get(parentId);
      if (!parent) break;
      seen.add(parentId);
      up.unshift(parent);
      cursor = parent;
    }

    const down: Feature[] = [];
    cursor = moved;
    while (cursor) {
      const current: Feature = cursor;
      const consumers: Feature[] = this.#features.filter((f) => {
        const role = primaryRoleOf(f);
        return role !== undefined && f.inputs[role] === current.id;
      });
      if (consumers.length !== 1) break; // fork, or the end of the chain
      const next: Feature = consumers[0]!;
      if (seen.has(next.id)) break;
      seen.add(next.id);
      down.push(next);
      cursor = next;
    }

    return [...up, moved, ...down];
  }

  /**
   * Reject an order that would show a feature above something it depends on.
   *
   * The graph would still build it correctly — build order comes from dependencies, not
   * the list — but a tree that reads in an order the model does not follow is just
   * confusing.
   */
  #orderIsReadable(features: readonly Feature[], edits: readonly RewireEdit[]): string | null {
    const patched = features.map((f) => {
      const forThis = edits.filter((e) => e.id === f.id);
      if (forThis.length === 0) return f;
      const inputs = { ...f.inputs };
      for (const e of forThis) inputs[e.role] = e.to;
      return { ...f, inputs };
    });

    const position = new Map(patched.map((f, i) => [f.id as string, i]));
    for (const feature of patched) {
      for (const upstream of Object.values(feature.inputs)) {
        const at = position.get(upstream as string);
        if (at === undefined) continue;
        if (at > position.get(feature.id as string)!) {
          const dep = patched.find((f) => f.id === upstream)!;
          return `"${feature.name || feature.type}" would sit above ` +
            `"${dep.name || dep.type}", which it depends on`;
        }
      }
    }
    return null;
  }

  setSuppressed(id: FeatureId, suppressed: boolean, opts: EditOptions = {}): boolean {
    const feature = this.feature(id);
    if (!feature || feature.suppressed === suppressed) return false;
    this.updateFeature(id, { suppressed }, {
      label: suppressed ? 'Suppress' : 'Unsuppress', ...opts,
    });
    return true;
  }

  // ------------------------------------------------------------------ rebuilding
  /**
   * Rebuild the dirty branch.
   *
   * A run already in flight is cancelled, so holding a key down or dragging a slider
   * cannot pile up overlapping rebuilds.
   */
  async recompute(): Promise<RecomputeResult> {
    this.#running?.cancel();
    const token = new CancellationToken();
    this.#running = token;

    const changed = this.#everRecomputed ? [...this.#dirty] : undefined;
    this.#dirty.clear();

    const result = await this.engine.recompute(this.parameters, this.#features, {
      ...(changed ? { changed } : {}),
      token,
    });

    if (!result.cancelled) {
      this.#everRecomputed = true;
      this.#running = null;
      // Release cached geometry no live feature references. Without this a long editing
      // session leaks a shape handle per distinct parameter value ever visited — cheap
      // in the MockKernel, but real memory inside OCCT.
      const live = new Set<string>();
      for (const state of result.states.values()) if (state.hash) live.add(state.hash);
      await this.engine.evict(live, this.cacheLimit);
    } else {
      // A cancelled run computed nothing usable; its dirt still needs doing.
      if (changed) for (const node of changed) this.#dirty.add(node);
    }
    return result;
  }

  /** Force the next recompute to rebuild everything. */
  invalidateAll(): void {
    this.#everRecomputed = false;
    this.#dirty.clear();
  }

  // ------------------------------------------------------------------ undo
  #restore(snapshot: DocumentSnapshot): void {
    this.parameters.clear();
    for (const p of snapshot.parameters) this.parameters.set(p);
    this.#features = snapshot.features.map((f) => structuredClone(f));
    this.#meta = { ...snapshot.meta };
    // The graph shape may have changed arbitrarily, so rebuild everything. Geometry is
    // still cheap to recover: the content cache is warm for states we have visited.
    this.invalidateAll();
  }

  undo(): boolean {
    const entry = this.#history.undo(this.snapshot());
    if (!entry) return false;
    this.#restore(entry.state);
    return true;
  }

  redo(): boolean {
    const entry = this.#history.redo(this.snapshot());
    if (!entry) return false;
    this.#restore(entry.state);
    return true;
  }

  clearHistory(): void { this.#history.clear(); }

  // ------------------------------------------------------------------ persistence
  toJSON(): DocumentFile {
    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      meta: this.#meta,
      parameters: this.parameters.all(),
      features: this.#features.map((f) => structuredClone(f)),
    };
  }

  static fromJSON(
    raw: unknown,
    kernel: KernelPort,
    registry: FeatureRegistry = createBuiltinRegistry(),
  ): Document {
    const file = migrate(raw);
    const doc = new Document(kernel, registry);
    for (const p of file.parameters) doc.parameters.set(p);
    doc.#features = file.features.map((f) => structuredClone(f));
    doc.#meta = file.meta;
    // Keep generated ids clear of anything already in the file.
    for (const f of doc.#features) {
      const m = /^f(\d+)$/.exec(f.id);
      if (m) doc.#idCounter = Math.max(doc.#idCounter, Number(m[1]));
    }
    doc.clearHistory();
    doc.invalidateAll();
    return doc;
  }

  /** Create a sketch and the feature that turns it into a face. */
  addSketch(plane: SketchPlane, opts: EditOptions = {}): { sketch: Sketch; id: FeatureId } {
    const sketchId = `sk${++this.#nextSketchId}`;
    const sketch = new Sketch(plane);
    // The origin is fixed so a sketch is never free to float away from its own plane.
    sketch.addPoint(0, 0, { fixed: true, id: 'origin' });
    this.sketches.set(sketchId, sketch);

    const id = this.newFeatureId('sketch');
    this.addFeature(
      { id, type: 'sketch', name: `Sketch ${this.#nextSketchId}`, values: {}, inputs: {}, sketchId },
      undefined,
      { label: 'Add sketch', ...opts },
    );
    return { sketch, id };
  }

  /**
   * Mark a sketch's feature dirty after the sketch itself was edited.
   *
   * A Sketch is a live object the drawing tools mutate directly, so nothing goes through
   * `updateFeature` and the graph would otherwise never learn it changed — the rebuild
   * would keep serving whatever the sketch produced before the user drew anything.
   *
   * Deliberately does NOT record undo history: a drawing session is a stream of small
   * edits, and one history entry per click would bury everything else.
   */
  markSketchChanged(featureId: FeatureId): void {
    this.#markDirty(featureNode(featureId));
    this.#meta = { ...this.#meta, modified: new Date().toISOString() };
  }

  sketchFor(featureId: FeatureId): Sketch | null {
    const feature = this.feature(featureId);
    return feature?.sketchId ? this.sketches.get(feature.sketchId) ?? null : null;
  }

  rename(name: string, opts: EditOptions = {}): void {
    this.#beginEdit(opts, 'Rename');
    this.#meta = { ...this.#meta, name };
  }
}
