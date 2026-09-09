import { type FeatureId, asFeatureId, type KernelPort } from '@cardstock/types';
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

  constructor(kernel: KernelPort, registry: FeatureRegistry = createBuiltinRegistry()) {
    this.registry = registry;
    this.engine = new RecomputeEngine(kernel, registry);
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
    const graph = buildGraph(this.parameters, this.#features);
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

  /** Reorder in the tree. Presentational only — see the class comment. */
  moveFeature(id: FeatureId, toIndex: number, opts: EditOptions = {}): boolean {
    const from = this.#features.findIndex((f) => f.id === id);
    if (from < 0 || toIndex < 0 || toIndex >= this.#features.length) return false;
    this.#beginEdit(opts, 'Reorder');
    const [f] = this.#features.splice(from, 1);
    this.#features.splice(toIndex, 0, f!);
    return true;
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

  rename(name: string, opts: EditOptions = {}): void {
    this.#beginEdit(opts, 'Rename');
    this.#meta = { ...this.#meta, name };
  }
}
