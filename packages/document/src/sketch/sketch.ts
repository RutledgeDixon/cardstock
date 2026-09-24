import type { ExternalItem } from './external.js';
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

export type SketchStatus = 'under-constrained' | 'fully-constrained' | 'over-constrained' | 'unsolvable' | 'unsolved';

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
  /** Constraints the last solve found to be saying nothing new, or contradicting others. */
  get redundant(): readonly string[] { return this.#lastSolve?.redundant ?? []; }
  get conflicting(): readonly string[] { return this.#lastSolve?.conflicting ?? []; }
  /** Why the last solve could not be done, when it could not. */
  get solveMessage(): string | null { return this.#lastSolve?.message ?? null; }

  get status(): SketchStatus {
    const solve = this.#lastSolve;
    if (!solve) return 'unsolved';
    if (solve.conflicting.length > 0 || solve.redundant.length > 0) return 'over-constrained';
    // A solve that failed or blew up is not a constraint problem to fix by deleting
    // things; it is reported as what it is, with the solver's own message.
    if (solve.status === 'failed' || solve.status === 'invalid' || solve.dof < 0) return 'unsolvable';
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

  addLine(
    p1: SketchEntityId, p2: SketchEntityId, construction = false, owner?: SketchEntityId,
  ): SketchEntityId {
    this.#requirePoint(p1);
    this.#requirePoint(p2);
    const id = this.newId('l');
    this.#geometry.set(id, {
      id, type: 'line', p1, p2,
      ...(construction ? { construction } : {}), ...(owner ? { owner } : {}),
    });
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
    this.#geometry.set(id, {
      id, type: 'arc', centre, radius, start, end, startAngle, endAngle,
    });
    return id;
  }

  /**
   * Bring the sketch's external reference geometry up to date.
   *
   * Entities keyed `external` are created for new items, moved for existing ones, and
   * removed — with their constraints — when the item is gone. Lines name their ends by
   * point key, so a corner two edges share is one point; a circle's centre is `<key>.c`.
   * Everything is fixed, and lines and circles are construction, so nothing here can
   * move, be part of a profile, or be dragged.
   */
  syncExternal(items: readonly ExternalItem[]): void {
    const byKey = new Map<string, SketchGeometry>();
    for (const e of this.#geometry.values()) if (e.external) byKey.set(e.external, e);
    const idByKey = new Map<string, SketchEntityId>();

    const point = (key: string, at: Vec2): SketchEntityId => {
      const existing = byKey.get(key);
      if (existing?.type === 'point') {
        this.#geometry.set(existing.id, { ...existing, x: at.x, y: at.y });
        byKey.delete(key);
        idByKey.set(key, existing.id);
        return existing.id;
      }
      const id = this.newId('x');
      this.#geometry.set(id, { id, type: 'point', x: at.x, y: at.y, fixed: true, external: key });
      idByKey.set(key, id);
      return id;
    };

    // Points first: lines refer to them by key.
    for (const item of items) if (item.kind === 'point') point(item.key, item.at);
    for (const item of items) {
      if (item.kind === 'point') continue;
      if (item.kind === 'line') {
        const p1 = idByKey.get(item.p1), p2 = idByKey.get(item.p2);
        if (!p1 || !p2) continue;
        const existing = byKey.get(item.key);
        if (existing?.type === 'line') {
          this.#geometry.set(existing.id, { ...existing, p1, p2 });
          byKey.delete(item.key);
          continue;
        }
        const id = this.newId('x');
        this.#geometry.set(id, { id, type: 'line', p1, p2, construction: true, external: item.key });
        continue;
      }
      const centre = point(`${item.key}.c`, item.centre);
      const existing = byKey.get(item.key);
      if (existing?.type === 'circle') {
        this.#geometry.set(existing.id, { ...existing, radius: item.radius });
        byKey.delete(item.key);
        continue;
      }
      const id = this.newId('x');
      this.#geometry.set(id, { id, type: 'circle', centre, radius: item.radius, construction: true, external: item.key });
    }
    // Whatever was not matched is gone from the outside world.
    for (const stale of byKey.values()) this.remove(stale.id);
  }

  /**
   * Remove geometry, and every constraint that referenced it.
   *
   * Leaving a constraint pointing at a deleted entity makes the whole sketch fail to
   * solve, with a message about something that is no longer on screen.
   */
  remove(id: SketchEntityId): boolean {
    const removed = this.#geometry.get(id);
    if (!removed) return this.#constraints.delete(id);
    this.#geometry.delete(id);

    // Anything built as part of this entity goes with it: construction lines an arc
    // owns mean nothing once the arc is gone.
    if (removed.type !== 'point') {
      for (const entity of [...this.#geometry.values()]) {
        if (entity.type === 'line' && entity.owner === id) this.remove(entity.id);
      }
    }

    // A point takes every curve built on it: a line with one end gone is not a line,
    // and handing the solver one is what produced "-1 DOF" — it could not find the
    // point, declared the sketch invalid, and reported nonsense.
    if (removed.type === 'point') {
      for (const entity of [...this.#geometry.values()]) {
        const ends = entity.type === 'line' ? [entity.p1, entity.p2]
          : entity.type === 'circle' ? [entity.centre]
          : entity.type === 'arc' ? [entity.centre, entity.start, entity.end]
          : [];
        if (ends.includes(id)) this.remove(entity.id);
      }
    }

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

    // The drag itself is handled by the solver, which pins the point under the cursor
    // and moves as little else as it can (see the adapter). Nothing is pre-moved here:
    // an earlier version translated everything connected to the point first, and the
    // far side of a part slid along with an arc end that had no business moving it.
    const geometry = this.#seedArcs(this.geometry, resolved, drag?.point);

    const result = await solver.solve({
      geometry,
      constraints: usable,
      parameters,
      ...(drag ? { drag } : {}),
    });
    if (drag) {
      // A drag may only land somewhere NEAR. The solver, asked to move one point,
      // sometimes finds a valid configuration a long way off — everything flung
      // out of view — or "converges" to something that is not a solution at all.
      // Neither is a drag, and neither is a pull the constraints simply forbid: a point
      // with nothing left to give makes the pinned system conflicting, the solve fails,
      // and the sketch must stay exactly as it was. If any point would move further than
      // the pointer did (with room for the shape to swing), the sketch stays as it is;
      // the next pointer move tries again from where it was. It is fine to hop to a
      // nearby valid place; it is never fine to explode.
      if (result.status !== 'solved' || this.#dragTooFar(drag, result)) {
        this.#lastSolve = { ...result, status: 'solved', points: {}, radii: {}, angles: {} };
        return this.#lastSolve;
      }
    }
    this.#lastSolve = result;
    if (result.status === 'solved' || result.status === 'converged') this.#applySolution(result);
    return result;
  }

  #dragTooFar(drag: { point: SketchEntityId; x: number; y: number }, result: SolveResult): boolean {
    const dragged = this.#geometry.get(drag.point);
    if (dragged?.type !== 'point') return false;
    const pulled = Math.hypot(drag.x - dragged.x, drag.y - dragged.y);
    // Generous: a point on a rotating shape can move a few times the pull. Beyond that
    // the solver has jumped to a different solution branch, not followed the pointer.
    const limit = pulled * 4 + 1e-6;
    for (const [id, position] of Object.entries(result.points)) {
      const before = this.#geometry.get(id);
      if (before?.type !== 'point') continue;
      if (Math.hypot(position.x - before.x, position.y - before.y) > limit) return true;
    }
    return false;
  }

  /**
   * Start each arc with a sweep dimension where that dimension says it should be.
   *
   * The solver is iterative, and a sweep typed from 180 to 90 asks the arc's ends to
   * travel a long way round the circle; from the old positions it converges to a
   * nearby non-solution instead. Rotating the ends to the dimensioned sweep first —
   * a plain calculation about the arc's own centre — hands it a guess that is already
   * right, so it only has to settle whatever else the change touched.
   *
   * The sweep is shared out evenly about the arc's middle, so the arc opens and closes
   * symmetrically rather than swinging one end round the other.
   */
  #seedArcs(
    geometry: SketchGeometry[],
    constraints: SketchConstraint[],
    /** The point under the cursor, which is being placed by the drag, not by a guess. */
    dragged?: SketchEntityId,
  ): SketchGeometry[] {
    const byId = new Map(geometry.map((e) => [e.id, e] as const));
    const out = new Map(byId);
    for (const c of constraints) {
      if (c.type !== 'sweep' || typeof c.value !== 'number' || c.reference) continue;
      const arc = byId.get(c.entity);
      if (arc?.type !== 'arc') continue;
      const centre = byId.get(arc.centre);
      if (centre?.type !== 'point') continue;
      const wanted = (c.value * Math.PI) / 180;
      const middle = (arc.startAngle + arc.endAngle) / 2;
      const start = middle - wanted / 2, end = middle + wanted / 2;
      out.set(arc.id, { ...arc, startAngle: start, endAngle: end });
      for (const [id, angle] of [[arc.start, start], [arc.end, end]] as const) {
        const p = byId.get(id);
        if (p?.type === 'point' && !p.fixed && id !== dragged) {
          out.set(id, {
            ...p,
            x: centre.x + arc.radius * Math.cos(angle),
            y: centre.y + arc.radius * Math.sin(angle),
          });
        }
      }
    }
    return [...out.values()];
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
    for (const [id, angle] of Object.entries(result.angles ?? {})) {
      const entity = this.#geometry.get(id);
      if (entity?.type === 'arc') {
        this.#geometry.set(id, { ...entity, startAngle: angle.start, endAngle: angle.end });
      }
    }
  }

  // ------------------------------------------------------------------ persistence
  toJSON(): SketchData {
    return { plane: this.plane, geometry: this.geometry, constraints: this.constraints };
  }

  static fromJSON(data: SketchData): Sketch {
    const sketch = new Sketch(data.plane);
    sketch.replaceWith(data);
    return sketch;
  }

  /**
   * Become this data, in place.
   *
   * Undo restores sketches this way rather than swapping objects, because an open
   * editing session holds the Sketch it is editing and must keep holding it.
   */
  replaceWith(data: SketchData): void {
    this.#geometry.clear();
    this.#constraints.clear();
    this.#expressionErrors.clear();
    this.#lastSolve = null;
    for (const entity of data.geometry) this.#geometry.set(entity.id, structuredClone(entity));
    for (const constraint of data.constraints) this.#constraints.set(constraint.id, structuredClone(constraint));
    // Keep minted ids clear of everything already present.
    const numbers = [...data.geometry, ...data.constraints]
      .map((item) => /^[a-z]+(\d+)$/.exec(item.id)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number);
    this.#nextId = numbers.length > 0 ? Math.max(...numbers) : 0;
  }
}

/** Every entity id a constraint refers to. */
export function referencedIds(constraint: SketchConstraint): SketchEntityId[] {
  const c = constraint as Record<string, unknown>;
  return ['a', 'b', 'line', 'point', 'entity', 'circle', 'axis']
    .map((key) => c[key])
    .filter((value): value is string => typeof value === 'string');
}

export const distance = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
