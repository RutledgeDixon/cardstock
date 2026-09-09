/**
 * The dependency DAG over parameters and features.
 *
 * The feature list is ordered, but dependencies are a graph, not a chain: a feature
 * depends on the parameters its expressions read and on the features its shape inputs
 * name. That is what lets a parameter edit rebuild only the affected branch instead of
 * everything after it in the list.
 */

export type NodeId = string;

export const paramNode = (name: string): NodeId => `p:${name}`;
export const featureNode = (id: string): NodeId => `f:${id}`;
export const isParamNode = (id: NodeId): boolean => id.startsWith('p:');
export const isFeatureNode = (id: NodeId): boolean => id.startsWith('f:');
export const nodeName = (id: NodeId): string => id.slice(2);

export interface TopologicalResult {
  /** Nodes in an order where every dependency precedes its dependents. */
  readonly order: readonly NodeId[];
  /** Nodes that could not be ordered because they participate in a cycle. */
  readonly cyclic: readonly NodeId[];
}

export class DependencyGraph {
  /** node -> the nodes it needs. */
  readonly #dependencies = new Map<NodeId, Set<NodeId>>();
  /** node -> the nodes that need it. */
  readonly #dependents = new Map<NodeId, Set<NodeId>>();
  /** Tie-break ordering among nodes that are equally ready. */
  readonly #priority = new Map<NodeId, number>();

  /**
   * Set the tie-break rank for a node.
   *
   * Topological order is not unique, so something has to break ties. Ranking features by
   * their position in the document makes independent branches build in the order the
   * user sees in the tree; without it the order falls out of node-id alphabetics, which
   * is deterministic but arbitrary and confusing to read in a rebuild log.
   */
  setPriority(id: NodeId, rank: number): void {
    this.addNode(id);
    this.#priority.set(id, rank);
  }

  #rank(id: NodeId): number {
    return this.#priority.get(id) ?? Number.MAX_SAFE_INTEGER;
  }

  #before(a: NodeId, b: NodeId): boolean {
    const ra = this.#rank(a);
    const rb = this.#rank(b);
    return ra !== rb ? ra < rb : a < b;
  }

  addNode(id: NodeId): void {
    if (!this.#dependencies.has(id)) this.#dependencies.set(id, new Set());
    if (!this.#dependents.has(id)) this.#dependents.set(id, new Set());
  }

  /** `dependent` needs `dependency`. */
  addEdge(dependency: NodeId, dependent: NodeId): void {
    this.addNode(dependency);
    this.addNode(dependent);
    this.#dependencies.get(dependent)!.add(dependency);
    this.#dependents.get(dependency)!.add(dependent);
  }

  get nodes(): NodeId[] { return [...this.#dependencies.keys()]; }
  dependenciesOf(id: NodeId): ReadonlySet<NodeId> { return this.#dependencies.get(id) ?? new Set(); }
  dependentsOf(id: NodeId): ReadonlySet<NodeId> { return this.#dependents.get(id) ?? new Set(); }

  /**
   * Kahn's algorithm. Anything left with unmet dependencies is in a cycle and is
   * reported rather than silently dropped — a cyclic feature must surface as an error,
   * not just quietly fail to rebuild.
   */
  topologicalOrder(): TopologicalResult {
    const indegree = new Map<NodeId, number>();
    for (const [node, deps] of this.#dependencies) indegree.set(node, deps.size);

    // Deterministic seed: the same document must always rebuild in the same order, or
    // tests and the regression corpus become flaky.
    const ready = [...indegree.entries()]
      .filter(([, n]) => n === 0)
      .map(([id]) => id)
      .sort((a, b) => (this.#before(a, b) ? -1 : 1));

    const order: NodeId[] = [];
    while (ready.length > 0) {
      const node = ready.shift()!;
      order.push(node);
      const dependents = [...(this.#dependents.get(node) ?? [])]
        .sort((a, b) => (this.#before(a, b) ? -1 : 1));
      for (const d of dependents) {
        const remaining = (indegree.get(d) ?? 0) - 1;
        indegree.set(d, remaining);
        if (remaining === 0) {
          // Keep `ready` ordered so ties break deterministically.
          const at = ready.findIndex((r) => this.#before(d, r));
          if (at === -1) ready.push(d); else ready.splice(at, 0, d);
        }
      }
    }

    const ordered = new Set(order);
    const cyclic = this.nodes
      .filter((n) => !ordered.has(n))
      .sort((a, b) => (this.#before(a, b) ? -1 : 1));
    return { order, cyclic };
  }

  /**
   * Everything that must be recomputed when `changed` changes, including `changed`
   * itself. Transitive closure over dependents.
   */
  dirtyFrom(changed: Iterable<NodeId>): Set<NodeId> {
    const dirty = new Set<NodeId>();
    const stack = [...changed];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (dirty.has(node)) continue;
      dirty.add(node);
      for (const d of this.#dependents.get(node) ?? []) {
        if (!dirty.has(d)) stack.push(d);
      }
    }
    return dirty;
  }

  /** Nodes `id` transitively depends on. Used to explain why something is blocked. */
  ancestorsOf(id: NodeId): Set<NodeId> {
    const seen = new Set<NodeId>();
    const stack = [...(this.#dependencies.get(id) ?? [])];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (seen.has(node)) continue;
      seen.add(node);
      for (const d of this.#dependencies.get(node) ?? []) stack.push(d);
    }
    return seen;
  }
}
