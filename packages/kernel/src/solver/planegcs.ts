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

    for (const constraint of request.constraints) {
      primitives.push(...toGcsConstraints(constraint));
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

function toGcsConstraints(c: SketchConstraint): unknown[] {
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
    case 'radius':
      return [{ id: c.id, type: 'circle_radius', c_id: c.entity, radius: dim(c.value) }];
    case 'diameter':
      return [{ id: c.id, type: 'circle_diameter', c_id: c.entity, diameter: dim(c.value) }];
    case 'angle':
      return [{ id: c.id, type: 'l2l_angle_ll', l1_id: c.a, l2_id: c.b, angle: dim(c.value) }];
    case 'lockX':
      return [{ id: c.id, type: 'coordinate_x', p_id: c.point, x: dim(c.value) }];
    case 'lockY':
      return [{ id: c.id, type: 'coordinate_y', p_id: c.point, y: dim(c.value) }];
  }
}
