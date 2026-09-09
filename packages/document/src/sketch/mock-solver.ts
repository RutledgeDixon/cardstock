import type { SolveRequest, SolveResult, SolverPort } from '@cardstock/types';

/**
 * A stand-in solver.
 *
 * Returns the geometry unchanged and a DOF count derived from a simple tally, so the
 * sketch model's own rules — what may be added, what deletion cascades to, what is
 * serialised — can be tested without WASM. It is not a solver and does not pretend to
 * be: tests that care about actual solving run against PlaneGCS in @cardstock/kernel.
 */
export class MockSolver implements SolverPort {
  readonly requests: SolveRequest[] = [];
  /** Force the next solve to report a conflict, to exercise the failure paths. */
  conflicting: string[] = [];
  status: SolveResult['status'] = 'solved';

  async solve(request: SolveRequest): Promise<SolveResult> {
    this.requests.push(request);

    const points: Record<string, { x: number; y: number }> = {};
    const radii: Record<string, number> = {};
    for (const entity of request.geometry) {
      if (entity.type === 'point') {
        const dragged = request.drag?.point === entity.id ? request.drag : null;
        points[entity.id] = dragged
          ? { x: dragged.x, y: dragged.y }
          : { x: entity.x, y: entity.y };
      } else if (entity.type === 'circle' || entity.type === 'arc') {
        radii[entity.id] = entity.radius;
      }
    }

    // Two freedoms per non-fixed point, one per radius, minus a rough constraint tally.
    const freedoms = request.geometry.reduce((n, e) => {
      if (e.type === 'point') return n + (e.fixed ? 0 : 2);
      if (e.type === 'circle' || e.type === 'arc') return n + 1;
      return n;
    }, 0);
    const removed = request.constraints.length;

    return {
      status: this.conflicting.length > 0 ? 'failed' : this.status,
      dof: Math.max(0, freedoms - removed),
      points,
      radii,
      conflicting: [...this.conflicting],
      redundant: [],
    };
  }
}
