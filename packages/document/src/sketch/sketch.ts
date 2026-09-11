import type {
  NewSketchConstraint, SketchConstraint, SketchEntityId, SketchGeometry,
  SolveResult, SolverPort, Vec2,
} from '@cardstock/types';
import type { TopoRef } from '../toporef/types.js';
import { evaluate, parse, referencedNames } from '../params/expression.js';

/**
 * A 2D sketch: geometry, constraints, and the plane it lives on.
 *
 * Pure — it describes a sketch and asks a SolverPort to solve it, never touching WASM,
 * so every rule about what a sketch may contain is testable in Node.
 */

/** Where a sketch lives in 3D. */
export type SketchPlane =
  | { readonly kind: 'origin'; readonly plane: 'xy' | 'xz' | 'yz' }
  /** A planar face of an existing body, held durably so it survives rebuilds. */
  | { readonly kind: 'face'; readonly ref: TopoRef };

export interface SketchData {
  readonly plane: SketchPlane;
  readonly geometry: readonly SketchGeometry[];
  readonly constraints: readonly SketchConstraint[];
}

export type SketchStatus = 'under-constrained' | 'fully-constrained' | 'over-constrained' | 'unsolved';

export class Sketch {
  #geometry = new Map<SketchEntityId, SketchGeometry>();
  #constraints = new Map<string, SketchConstraint>();
  #nextId = 0;
  #lastSolve: SolveResult | null = null;
  /** Dimensions whose expression could not be evaluated, by constraint id. */
  readonly #expressionErrors = new Map<string, string>();

  constructor(public plane: SketchPlane) {}

  // ------------------------------------------------------------------ reading
  get geometry(): SketchGeometry[] { return [...this.#geometry.values()]; }
  get constraints(): SketchConstraint[] { return [...this.#constraints.values()]; }
  get lastSolve(): SolveResult | null { return this.#lastSolve; }
  get expressionErrors(): ReadonlyMap<string, string> { return this.#expressionErrors; }
  entity(id: SketchEntityId): SketchGeometry | undefined { return this.#geometry.get(id); }
  constraint(id: string): SketchConstraint | undefined { return this.#constraints.get(id); }

  /** Remaining degrees of freedom, or null before the first solve. */
  get dof(): number | null { return this.#lastSolve ? this.#lastSolve.dof : null; }

  get status(): SketchStatus {
    const solve = this.#lastSolve;
    if (!solve) return 'unsolved';
    if (solve.conflicting.length > 0 || solve.status === 'failed') return 'over-constrained';
    return solve.dof === 0 ? 'fully-constrained' : 'under-constrained';
  }

  newId(prefix: string): string {
    let id: string;
    do { id = `${prefix}${++this.#nextId}`; }
    while (this.#geometry.has(id) || this.#constraints.has(id));
    return id;
  }

  // ------------------------------------------------------------------ geometry
  addPoint(x: number, y: number, options: { fixed?: boolean; id?: string } = {}): SketchEntityId {
    const id = options.id ?? this.newId('p');
    this.#geometry.set(id, {
      id, type: 'point', x, y, ...(options.fixed ? { fixed: true } : {}),
    });
    return id;
  }

  addLine(p1: SketchEntityId, p2: SketchEntityId, construction = false): SketchEntityId {
    this.#requirePoint(p1);
    this.#requirePoint(p2);
    const id = this.newId('l');
    this.#geometry.set(id, { id, type: 'line', p1, p2, ...(construction ? { construction } : {}) });
    return id;
  }

  addCircle(centre: SketchEntityId, radius: number, construction = false): SketchEntityId {
    this.#requirePoint(centre);
    if (radius <= 0) throw new Error('circle radius must be positive');
    const id = this.newId('c');
    this.#geometry.set(id, {
      id, type: 'circle', centre, radius, ...(construction ? { construction } : {}),
    });
    return id;
  }

  addArc(
    centre: SketchEntityId, radius: number,
    start: SketchEntityId, end: SketchEntityId,
    startAngle: number, endAngle: number,
  ): SketchEntityId {
    this.#requirePoint(centre);
    this.#requirePoint(start);
    this.#requirePoint(end);
    const id = this.newId('a');
    this.#geometry.set(id, { id, type: 'arc', centre, radius, start, end, startAngle, endAngle });
    return id;
  }

  /**
   * Remove geometry, and every constraint that referenced it.
   *
   * Leaving a constraint pointing at a deleted entity makes the whole sketch fail to
   * solve, with a message about something that is no longer on screen.
   */
  remove(id: SketchEntityId): boolean {
    const existed = this.#geometry.delete(id);
    if (!existed) return this.#constraints.delete(id);

    // A line's points may be shared; only drop those nothing else uses.
    for (const [constraintId, constraint] of this.#constraints) {
      if (referencedIds(constraint).includes(id)) this.#constraints.delete(constraintId);
    }
    for (const orphan of this.#unreferencedPoints()) {
      this.#geometry.delete(orphan);
      for (const [constraintId, constraint] of this.#constraints) {
        if (referencedIds(constraint).includes(orphan)) this.#constraints.delete(constraintId);
      }
    }
    return true;
  }

  #unreferencedPoints(): SketchEntityId[] {
    const used = new Set<SketchEntityId>();
    for (const entity of this.#geometry.values()) {
      if (entity.type === 'line') { used.add(entity.p1); used.add(entity.p2); }
      if (entity.type === 'circle') used.add(entity.centre);
      if (entity.type === 'arc') { used.add(entity.centre); used.add(entity.start); used.add(entity.end); }
    }
    return this.geometry
      .filter((e): e is Extract<SketchGeometry, { type: 'point' }> =>
        e.type === 'point' && !used.has(e.id) && !e.fixed)
      .map((p) => p.id);
  }

  #requirePoint(id: SketchEntityId): void {
    const entity = this.#geometry.get(id);
    if (entity?.type !== 'point') throw new Error(`"${id}" is not a point in this sketch`);
  }

  // ------------------------------------------------------------------ constraints
  /** @returns the constraint id, or an error message. */
  addConstraint(constraint: NewSketchConstraint & { id?: string }): string {
    const id = constraint.id ?? this.newId('k');
    const full = { ...constraint, id } as SketchConstraint;
    for (const ref of referencedIds(full)) {
      if (!this.#geometry.has(ref)) throw new Error(`constraint references unknown "${ref}"`);
    }
    this.#constraints.set(id, full);
    return id;
  }

  removeConstraint(id: string): boolean { return this.#constraints.delete(id); }

  /**
   * Parameter names any dimension references.
   *
   * Parsed rather than taken literally, because a dimension may be a whole expression —
   * `wall * 3`, `boltM3 + clearance` — and the graph needs every name in it to know when
   * the sketch is out of date.
   */
  referencedParameters(): string[] {
    const names = new Set<string>();
    for (const constraint of this.#constraints.values()) {
      const value = (constraint as { value?: unknown }).value;
      if (typeof value !== 'string') continue;
      try {
        for (const name of referencedNames(parse(value))) names.add(name);
      } catch {
        // A malformed expression surfaces when it is evaluated, not here.
      }
    }
    return [...names];
  }

  // ------------------------------------------------------------------ solving
  async solve(
    solver: SolverPort,
    parameters: Readonly<Record<string, number>> = {},
    drag?: { point: SketchEntityId; x: number; y: number },
  ): Promise<SolveResult> {
    // Dimension expressions are evaluated here rather than handed to the solver.
    // PlaneGCS resolves a bare parameter NAME but not an expression, and a dimension
    // that can only be a literal or a single name wastes the parameter system.
    const scope = (name: string) => parameters[name];
    // Cleared BEFORE evaluating, not after: clearing afterwards wiped the very errors
    // the pass had just recorded, so a broken dimension reported nothing at all.
    this.#expressionErrors.clear();
    const resolved = this.constraints.map((constraint) => {
      const value = (constraint as { value?: unknown }).value;
      if (typeof value !== 'string') return constraint;
      try {
        return { ...constraint, value: evaluate(parse(value), scope) } as SketchConstraint;
      } catch (error) {
        this.#expressionErrors.set(constraint.id,
          error instanceof Error ? error.message : String(error));
        return constraint;
      }
    });

    // A dimension whose expression is broken is dropped from the solve rather than
    // passed through as a string the solver would read as a parameter name. The sketch
    // then solves as if that dimension were absent, and the error is reported against it.
    // A reference dimension only reports; it never reaches the solver.
    const usable = resolved.filter((c) => {
      const value = (c as { value?: unknown }).value;
      return typeof value !== 'string' && !(c as { reference?: boolean }).reference;
    });

    const result = await solver.solve({
      geometry: this.geometry,
      constraints: usable,
      parameters,
      ...(drag ? { drag } : {}),
    });
    this.#lastSolve = result;
    if (result.status === 'solved' || result.status === 'converged') this.#applySolution(result);
    return result;
  }

  /** Write solved positions back, so the stored sketch matches what is on screen. */
  #applySolution(result: SolveResult): void {
    for (const [id, position] of Object.entries(result.points)) {
      const entity = this.#geometry.get(id);
      if (entity?.type === 'point') {
        this.#geometry.set(id, { ...entity, x: position.x, y: position.y });
      }
    }
    for (const [id, radius] of Object.entries(result.radii)) {
      const entity = this.#geometry.get(id);
      if (entity?.type === 'circle' || entity?.type === 'arc') {
        this.#geometry.set(id, { ...entity, radius });
      }
    }
  }

  // ------------------------------------------------------------------ persistence
  toJSON(): SketchData {
    return { plane: this.plane, geometry: this.geometry, constraints: this.constraints };
  }

  static fromJSON(data: SketchData): Sketch {
    const sketch = new Sketch(data.plane);
    for (const entity of data.geometry) sketch.#geometry.set(entity.id, entity);
    for (const constraint of data.constraints) sketch.#constraints.set(constraint.id, constraint);
    // Keep minted ids clear of everything already present.
    const numbers = [...data.geometry, ...data.constraints]
      .map((item) => /^[a-z]+(\d+)$/.exec(item.id)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number);
    sketch.#nextId = numbers.length > 0 ? Math.max(...numbers) : 0;
    return sketch;
  }
}

/** Every entity id a constraint refers to. */
export function referencedIds(constraint: SketchConstraint): SketchEntityId[] {
  const c = constraint as Record<string, unknown>;
  return ['a', 'b', 'line', 'point', 'entity', 'circle']
    .map((key) => c[key])
    .filter((value): value is string => typeof value === 'string');
}

export const distance = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
