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

  async solve(request: SolveRequest): Promise<SolveResult> {
    this.gcs.clear_data();

    const primitives: unknown[] = [];

    // Parameters first: a constraint referencing one by name needs it to exist already.
    for (const [name, value] of Object.entries(request.parameters)) {
      primitives.push({ type: 'param', name, value });
    }

    // A drag moves the point's INITIAL GUESS, it does not add a constraint.
    //
    // Constraining the dragged point would over-constrain any sketch that is already
    // fully defined, so dragging a finished rectangle would report a conflict instead of
    // simply not moving. Seeding the guess lets the solver absorb the pull into whatever
    // freedom actually exists — which is what "pull, not pin" has to mean.
    const dragged = request.drag;
    for (const entity of request.geometry) {
      const seeded = dragged && entity.type === 'point' && entity.id === dragged.point
        ? { ...entity, x: dragged.x, y: dragged.y }
        : entity;
      primitives.push(...toPrimitives(seeded));
    }

    const lineStart = (lineId: string) => {
      const line = request.geometry.find((e) => e.id === lineId);
      return line?.type === 'line' ? line.p1 : lineId;
    };
    const isArc = (id: string) => request.geometry.find((e) => e.id === id)?.type === 'arc';
    const lineEnds = (lineId: string) => {
      const line = request.geometry.find((e) => e.id === lineId);
      return line?.type === 'line' ? { p1: line.p1, p2: line.p2 } : null;
    };
    const coincident = (a: string, b: string) => request.constraints.some((c) =>
      c.type === 'coincident' && ((c.a === a && c.b === b) || (c.a === b && c.b === a)));
    /** Whether an arc's ends are tied to its axis ends by coincident constraints. */
    const tiedEnds = (arcId: string) => {
      const arc = request.geometry.find((e) => e.id === arcId);
      const axis = arc?.type === 'arc' && arc.axis ? lineEnds(arc.axis) : null;
      if (arc?.type !== 'arc' || !axis) return { start: false, end: false };
      return { start: coincident(arc.start, axis.p1), end: coincident(arc.end, axis.p2) };
    };
    for (const constraint of request.constraints) {
      primitives.push(...toGcsConstraints(constraint, lineStart, isArc, lineEnds, tiedEnds));
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
        // An arc on an axis: both axis ends sit on its circle — which also keeps the
        // centre on the axis's perpendicular bisector.
        const axis = entity.axis ? request.geometry.find((e) => e.id === entity.axis) : undefined;
        if (axis?.type === 'line') {
          const radius = { o_id: entity.id, prop: 'radius' };
          // An axis end the arc's own end is tied to is on the circle already — the
          // arc rules put it there — and saying so twice makes the solver see a
          // conflict where there is only repetition.
          const tied = tiedEnds(entity.id);
          if (!tied.start) {
            primitives.push({ id: `${entity.id}#axisA`, type: 'p2p_distance', p1_id: entity.centre, p2_id: axis.p1, distance: radius });
          }
          if (!tied.end) {
            primitives.push({ id: `${entity.id}#axisB`, type: 'p2p_distance', p1_id: entity.centre, p2_id: axis.p2, distance: radius });
          }
        }
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
  tiedEnds: (arcId: string) => { start: boolean; end: boolean },
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
    case 'equal':
      return [{ id: c.id, type: 'equal', param1: c.a, param2: c.b }];
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
    case 'arcAngle': {
      // The arc sits symmetric about its axis's perpendicular bisector: with the axis
      // running a→b at angle α, the bisector points at α − 90° for a positive sweep —
      // the side an arc drawn counter-clockwise from a lands on — and α + 90° for a
      // negative one. The arc runs from bisector − |θ|/2 to bisector + |θ|/2. Both ends
      // are tied to the axis direction through the arc's own angle parameters, so the
      // sweep is a number the user owns and the centre never moves to honour it.
      const axis = lineEnds(c.axis);
      if (!axis || typeof c.value !== 'number') return [];
      const theta = (Math.abs(c.value) * Math.PI) / 180;
      const quarter = c.value < 0 ? Math.PI / 2 : -Math.PI / 2;
      // atan2(b − a) = start + incr  ⇒  start = α + quarter − θ/2  ⇒  incr = θ/2 − quarter
      const start = { id: `${c.id}#start`, type: 'p2p_angle_incr_angle', p1_id: axis.p1, p2_id: axis.p2, angle: { o_id: c.entity, prop: 'start_angle' }, incrAngle: theta / 2 - quarter };
      const end = { id: `${c.id}#end`, type: 'p2p_angle_incr_angle', p1_id: axis.p1, p2_id: axis.p2, angle: { o_id: c.entity, prop: 'end_angle' }, incrAngle: -theta / 2 - quarter };
      // With both ends tied to the axis ends, the end angle follows from the start
      // angle and the geometry; saying it too would be one equation too many.
      const tied = tiedEnds(c.entity);
      return tied.start && tied.end ? [start] : [start, end];
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
