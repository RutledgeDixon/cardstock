import { make_gcs_wrapper } from '@salusoft89/planegcs';
import type {
  Dimension, SketchConstraint, SketchGeometry, SolveRequest, SolveResult, SolverPort,
  SolveStatus, Vec2,
} from '@cardstock/types';

/**
 * SolverPort over PlaneGCS — FreeCAD's own 2D constraint solver, compiled to WASM.
 *
 * Reusing it turns Phase 6 from "write a constraint solver" into "drive one", which was
 * the single largest de-risking available (ADR-0003). This adapter translates our
 * contract into its API and, importantly, translates its diagnostics back into
 * *our* constraint ids, so an error names something the user actually placed.
 */

/** PlaneGCS SolveStatus: 0 Success, 1 Converged, 2 Failed, 3 SuccessfulSolutionInvalid. */
const STATUS: readonly SolveStatus[] = ['solved', 'converged', 'failed', 'invalid'];

type Gcs = Awaited<ReturnType<typeof make_gcs_wrapper>>;

let shared: Promise<Gcs> | null = null;

export function loadSolver(): Promise<Gcs> {
  shared ??= make_gcs_wrapper();
  return shared;
}

export class PlaneGcsSolver implements SolverPort {
  constructor(private readonly gcs: Gcs) {}

  static async create(): Promise<PlaneGcsSolver> {
    const gcs = await loadSolver();
    // The solver prints "Sketcher::RedundantSolving-DogLeg-" to stdout otherwise
    // (ADR-0003).
    (gcs as unknown as { debug_mode: number }).debug_mode = 0;
    return new PlaneGcsSolver(gcs);
  }

  /**
   * Solve, and when the caller is dragging, follow the pointer with the least movement
   * everywhere else.
   *
   * Two attempts, because neither way of expressing a drag is right on its own:
   *
   * - PINNED. The dragged point becomes a fixed point at the cursor, so the solver has
   *   to satisfy everything else around it, and DogLeg starting from the sketch's
   *   current positions moves as little as it can. This is what a drag should feel
   *   like, and it is what an earlier version could not do — it merely SUGGESTED the
   *   new position, which the solver was free to undo, so the caller compensated by
   *   translating everything connected to the point first. The solver then settled on
   *   the nearest solution to that displaced state, and geometry with nothing to do
   *   with the drag kept the offset: pull an arc's end, and the far side of the part
   *   slid sideways.
   *
   * - SEEDED. A pin fails whenever the point cannot actually reach the cursor — the
   *   free end of a horizontal line dragged upwards, or a sketch with no freedom left
   *   at all — because a fixed point turns "it cannot go there" into a contradiction.
   *   So that case falls back to offering the cursor as the initial guess and letting
   *   the constraints pull it back onto what is reachable: the end of that horizontal
   *   line follows in x and stays put in y, and a finished sketch does not move at all.
   *
   * The pin is tried first and kept only if it solved cleanly, which means the drag is
   * crisp exactly when the freedom to be crisp exists.
   */
  async solve(request: SolveRequest): Promise<SolveResult> {
    if (!request.drag) return this.#attempt(request, 'seed');
    const pinned = await this.#attempt(request, 'pin');
    if (pinned.status === 'solved' && pinned.conflicting.length === 0) return pinned;
    return this.#attempt(request, 'seed');
  }

  async #attempt(request: SolveRequest, mode: 'pin' | 'seed'): Promise<SolveResult> {
    this.gcs.clear_data();

    const primitives: unknown[] = [];

    // Parameters first: a constraint referencing one by name needs it to exist already.
    for (const [name, value] of Object.entries(request.parameters)) {
      primitives.push({ type: 'param', name, value });
    }

    const dragged = request.drag;
    for (const entity of request.geometry) {
      const moved = dragged && entity.type === 'point' && entity.id === dragged.point
        ? { ...entity, x: dragged.x, y: dragged.y, ...(mode === 'pin' ? { fixed: true } : {}) }
        : entity;
      primitives.push(...toPrimitives(moved));
    }

    const lineStart = (lineId: string) => {
      const line = request.geometry.find((e) => e.id === lineId);
      return line?.type === 'line' ? line.p1 : lineId;
    };
    const typeOf = (id: string) => request.geometry.find((e) => e.id === id)?.type;
    const isArc = (id: string) => typeOf(id) === 'arc';
    const lineEnds = (lineId: string) => {
      const line = request.geometry.find((e) => e.id === lineId);
      return line?.type === 'line' ? { p1: line.p1, p2: line.p2 } : null;
    };
    for (const constraint of request.constraints) {
      primitives.push(...toGcsConstraints(constraint, lineStart, isArc, lineEnds, typeOf));
    }
    // External circles are fixed in every respect; the centre is a fixed point already,
    // the radius needs pinning here since a circle primitive has no fixed flag.
    for (const entity of request.geometry) {
      if (entity.type === 'circle' && entity.external) {
        primitives.push({ id: `${entity.id}#fixed`, type: 'circle_radius', c_id: entity.id, radius: entity.radius });
      }
      // An arc's ends are only ON the arc if the rules say so; pushing the primitive
      // alone leaves three points and three numbers with nothing tying them together.
      if (entity.type === 'arc') {
        primitives.push({ id: `${entity.id}#rules`, type: 'arc_rules', a_id: entity.id });
      }
    }

    try {
      this.gcs.push_primitives_and_params(primitives as never);
    } catch (error) {
      return failure(request, error instanceof Error ? error.message : String(error));
    }

    let status: SolveStatus;
    try {
      status = STATUS[this.gcs.solve() as number] ?? 'failed';
      if (status === 'solved' || status === 'converged') this.gcs.apply_solution();
    } catch (error) {
      return failure(request, error instanceof Error ? error.message : String(error));
    }

    const points: Record<string, Vec2> = {};
    const radii: Record<string, number> = {};
    const angles: Record<string, { start: number; end: number }> = {};
    for (const entity of request.geometry) {
      if (entity.type === 'point') {
        const solved = this.gcs.sketch_index.get_sketch_point(entity.id);
        if (solved) points[entity.id] = { x: solved.x, y: solved.y };
      } else if (entity.type === 'circle') {
        const solved = this.gcs.sketch_index.get_sketch_circle(entity.id);
        if (typeof solved?.radius === 'number') radii[entity.id] = solved.radius;
      } else if (entity.type === 'arc') {
        const solved = this.gcs.sketch_index.get_sketch_arc(entity.id);
        if (typeof solved?.radius === 'number') radii[entity.id] = solved.radius;
        if (typeof solved?.start_angle === 'number' && typeof solved?.end_angle === 'number') {
          angles[entity.id] = { start: solved.start_angle, end: solved.end_angle };
        }
      }
    }

    // Map the solver's ids back to ours, dropping anything internal: a diagnostic must
    // name something the user actually placed.
    const ours = new Set(request.constraints.map((c) => c.id));
    const mine = (ids: string[]) =>
      [...new Set(ids.map(baseId).filter((id) => ours.has(id)))];

    return {
      status,
      dof: this.gcs.gcs.dof(),
      points,
      radii,
      angles,
      conflicting: mine(this.gcs.get_gcs_conflicting_constraints()),
      redundant: mine(this.gcs.get_gcs_redundant_constraints()),
    };
  }
}

/** Some constraints expand into several GCS ones, suffixed `id#n`. */
const baseId = (id: string): string => id.split('#')[0]!;

function failure(request: SolveRequest, message: string): SolveResult {
  // Hand back the geometry unchanged so the caller can still draw something.
  const points: Record<string, Vec2> = {};
  const radii: Record<string, number> = {};
  for (const entity of request.geometry) {
    if (entity.type === 'point') points[entity.id] = { x: entity.x, y: entity.y };
    else if (entity.type === 'circle' || entity.type === 'arc') radii[entity.id] = entity.radius;
  }
  return { status: 'invalid', dof: -1, points, radii, conflicting: [], redundant: [], message };
}

function toPrimitives(entity: SketchGeometry): unknown[] {
  switch (entity.type) {
    case 'point':
      return [{ id: entity.id, type: 'point', x: entity.x, y: entity.y, fixed: entity.fixed ?? false }];
    case 'line':
      return [{ id: entity.id, type: 'line', p1_id: entity.p1, p2_id: entity.p2 }];
    case 'circle':
      return [{ id: entity.id, type: 'circle', c_id: entity.centre, radius: entity.radius }];
    case 'arc':
      return [{
        id: entity.id, type: 'arc', c_id: entity.centre, radius: entity.radius,
        start_id: entity.start, end_id: entity.end,
        start_angle: entity.startAngle, end_angle: entity.endAngle,
      }];
  }
}

/** A dimension is passed straight through: a number is a literal, a string a parameter. */
const dim = (value: Dimension): number | string => value;

function toGcsConstraints(
  c: SketchConstraint, lineStart: (lineId: string) => string, isArc: (id: string) => boolean,
  lineEnds: (lineId: string) => { p1: string; p2: string } | null,
  typeOf: (id: string) => string | undefined,
): unknown[] {
  switch (c.type) {
    case 'coincident':
      return [{ id: c.id, type: 'p2p_coincident', p1_id: c.a, p2_id: c.b }];
    case 'horizontal':
      return [{ id: c.id, type: 'horizontal_l', l_id: c.line }];
    case 'vertical':
      return [{ id: c.id, type: 'vertical_l', l_id: c.line }];
    case 'parallel':
      return [{ id: c.id, type: 'parallel', l1_id: c.a, l2_id: c.b }];
    case 'perpendicular':
      return [{ id: c.id, type: 'perpendicular_ll', l1_id: c.a, l2_id: c.b }];
    case 'tangent':
      return [{ id: c.id, type: 'tangent_lc', l_id: c.a, c_id: c.b }];
    case 'equal': {
      // GCS's plain `equal` is for parameters, not entities: handing it entity ids
      // threw "unknown param" and the whole sketch failed to solve. Lines are equal
      // in length; circles and arcs in radius, each pairing its own constraint.
      const a = typeOf(c.a), b = typeOf(c.b);
      if (a === 'line' && b === 'line') return [{ id: c.id, type: 'equal_length', l1_id: c.a, l2_id: c.b }];
      if (a === 'circle' && b === 'circle') return [{ id: c.id, type: 'equal_radius_cc', c1_id: c.a, c2_id: c.b }];
      if (a === 'arc' && b === 'arc') return [{ id: c.id, type: 'equal_radius_aa', a1_id: c.a, a2_id: c.b }];
      if (a === 'circle' && b === 'arc') return [{ id: c.id, type: 'equal_radius_ca', c1_id: c.a, a2_id: c.b }];
      if (a === 'arc' && b === 'circle') return [{ id: c.id, type: 'equal_radius_ca', c1_id: c.b, a2_id: c.a }];
      return [];
    }
    case 'concentric':
      return [{ id: c.id, type: 'p2p_coincident', p1_id: c.a, p2_id: c.b }];
    case 'pointOnLine':
      return [{ id: c.id, type: 'point_on_line_pl', p_id: c.point, l_id: c.line }];
    case 'symmetric':
      return [{ id: c.id, type: 'p2p_symmetric_ppl', p1_id: c.a, p2_id: c.b, l_id: c.line }];
    case 'distance':
      return [{ id: c.id, type: 'p2p_distance', p1_id: c.a, p2_id: c.b, distance: dim(c.value) }];
    case 'pointLineDistance':
      return [{ id: c.id, type: 'p2l_distance', p_id: c.point, l_id: c.line, distance: dim(c.value) }];
    case 'lineLineDistance':
      // The gap between parallel lines is the distance from either end of one to the
      // other; parallelism itself is a separate constraint, added alongside.
      return [{ id: c.id, type: 'p2l_distance', p_id: lineStart(c.a), l_id: c.b, distance: dim(c.value) }];
    case 'circleLineDistance':
      return [{ id: c.id, type: 'c2ldistance', c_id: c.circle, l_id: c.line, dist: dim(c.value) }];
    case 'pointCircleDistance':
      return [{ id: c.id, type: 'p2cdistance', p_id: c.point, c_id: c.circle, distance: dim(c.value) }];
    case 'radius':
      // Arcs have their own radius constraint in GCS; a circle's does not apply to them.
      return isArc(c.entity)
        ? [{ id: c.id, type: 'arc_radius', a_id: c.entity, radius: dim(c.value) }]
        : [{ id: c.id, type: 'circle_radius', c_id: c.entity, radius: dim(c.value) }];
    case 'sweep': {
      // How far round the arc goes: its end angle minus its start angle, which is the
      // arc's own definition of itself and needs nothing else to measure against.
      //
      // This used to be an angle from an AXIS — a construction line between the arc's
      // ends, with the centre on its perpendicular bisector — which took two equations
      // tying both ends to the axis direction, a pair of distance constraints holding
      // the axis ends on the circle, a rule for when the arc's ends WERE the axis ends
      // (say it twice and the solver sees a conflict), and a sign convention for which
      // side of the axis the bulge fell on. All of it to express one number the arc
      // already carries. The sign of the sweep now says which way round it goes, which
      // is the same thing the side-of-the-axis rule was for.
      if (typeof c.value !== 'number') return [];
      return [{
        id: c.id, type: 'difference',
        param1: { o_id: c.entity, prop: 'start_angle' },
        param2: { o_id: c.entity, prop: 'end_angle' },
        difference: (c.value * Math.PI) / 180,
      }];
    }
    case 'diameter':
      return isArc(c.entity)
        ? [{ id: c.id, type: 'arc_diameter', a_id: c.entity, diameter: dim(c.value) }]
        : [{ id: c.id, type: 'circle_diameter', c_id: c.entity, diameter: dim(c.value) }];
    case 'angle':
      return [{ id: c.id, type: 'l2l_angle_ll', l1_id: c.a, l2_id: c.b, angle: dim(c.value) }];
    case 'lockX':
      return [{ id: c.id, type: 'coordinate_x', p_id: c.point, x: dim(c.value) }];
    case 'lockY':
      return [{ id: c.id, type: 'coordinate_y', p_id: c.point, y: dim(c.value) }];
  }
}
