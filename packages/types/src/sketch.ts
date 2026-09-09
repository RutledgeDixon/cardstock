/**
 * 2D sketch geometry and constraints.
 *
 * Coordinates are in the sketch plane's own frame: millimetres, X right, Y up. The
 * plane's placement in 3D is the sketch feature's business, not the solver's.
 *
 * Ids are STRINGS throughout. PlaneGCS dispatches on `typeof === 'string'` for entity
 * references and fails with a misleading "unhandled parameter" error on numbers
 * (ADR-0003), so the contract makes that impossible to get wrong.
 */

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export type SketchEntityId = string;

/** A free point. Line ends, arc ends and circle centres are all points. */
export interface SketchPoint {
  readonly id: SketchEntityId;
  readonly type: 'point';
  readonly x: number;
  readonly y: number;
  /** Immovable, whatever the constraints say. The sketch origin is one of these. */
  readonly fixed?: boolean;
}

export interface SketchLine {
  readonly id: SketchEntityId;
  readonly type: 'line';
  readonly p1: SketchEntityId;
  readonly p2: SketchEntityId;
  /** Reference geometry: solved and drawn, but never part of a profile. */
  readonly construction?: boolean;
}

export interface SketchCircle {
  readonly id: SketchEntityId;
  readonly type: 'circle';
  readonly centre: SketchEntityId;
  readonly radius: number;
  readonly construction?: boolean;
}

export interface SketchArc {
  readonly id: SketchEntityId;
  readonly type: 'arc';
  readonly centre: SketchEntityId;
  readonly radius: number;
  readonly start: SketchEntityId;
  readonly end: SketchEntityId;
  /** Radians, counter-clockwise. */
  readonly startAngle: number;
  readonly endAngle: number;
  readonly construction?: boolean;
}

export type SketchGeometry = SketchPoint | SketchLine | SketchCircle | SketchArc;

/**
 * A dimension: either a literal, or the name of a document parameter.
 *
 * Naming a parameter is what makes a sketch follow the rest of the model — the same
 * mechanism the feature values use.
 */
export type Dimension = number | string;

export type SketchConstraint =
  // --- geometric
  | { readonly id: string; readonly type: 'coincident'; readonly a: SketchEntityId; readonly b: SketchEntityId }
  | { readonly id: string; readonly type: 'horizontal'; readonly line: SketchEntityId }
  | { readonly id: string; readonly type: 'vertical'; readonly line: SketchEntityId }
  | { readonly id: string; readonly type: 'parallel'; readonly a: SketchEntityId; readonly b: SketchEntityId }
  | { readonly id: string; readonly type: 'perpendicular'; readonly a: SketchEntityId; readonly b: SketchEntityId }
  | { readonly id: string; readonly type: 'tangent'; readonly a: SketchEntityId; readonly b: SketchEntityId }
  | { readonly id: string; readonly type: 'equal'; readonly a: SketchEntityId; readonly b: SketchEntityId }
  | { readonly id: string; readonly type: 'concentric'; readonly a: SketchEntityId; readonly b: SketchEntityId }
  | { readonly id: string; readonly type: 'pointOnLine'; readonly point: SketchEntityId; readonly line: SketchEntityId }
  | { readonly id: string; readonly type: 'symmetric'; readonly a: SketchEntityId; readonly b: SketchEntityId; readonly line: SketchEntityId }
  // --- dimensional
  | { readonly id: string; readonly type: 'distance'; readonly a: SketchEntityId; readonly b: SketchEntityId; readonly value: Dimension }
  | { readonly id: string; readonly type: 'pointLineDistance'; readonly point: SketchEntityId; readonly line: SketchEntityId; readonly value: Dimension }
  | { readonly id: string; readonly type: 'radius'; readonly entity: SketchEntityId; readonly value: Dimension }
  | { readonly id: string; readonly type: 'diameter'; readonly entity: SketchEntityId; readonly value: Dimension }
  | { readonly id: string; readonly type: 'angle'; readonly a: SketchEntityId; readonly b: SketchEntityId; readonly value: Dimension }
  | { readonly id: string; readonly type: 'lockX'; readonly point: SketchEntityId; readonly value: Dimension }
  | { readonly id: string; readonly type: 'lockY'; readonly point: SketchEntityId; readonly value: Dimension };

export type SketchConstraintType = SketchConstraint['type'];

/** Constraints carrying a numeric value, which the UI shows as an editable dimension. */
export const DIMENSIONAL_CONSTRAINTS: readonly SketchConstraintType[] = [
  'distance', 'pointLineDistance', 'radius', 'diameter', 'angle', 'lockX', 'lockY',
];

export const isDimensional = (type: SketchConstraintType): boolean =>
  DIMENSIONAL_CONSTRAINTS.includes(type);

// ---------------------------------------------------------------- solving

export interface SolveRequest {
  readonly geometry: readonly SketchGeometry[];
  readonly constraints: readonly SketchConstraint[];
  /** Values for any parameter names the constraints reference. */
  readonly parameters: Readonly<Record<string, number>>;
  /**
   * Pull one point toward a position while solving.
   *
   * How dragging works: the point is not pinned, it is pulled, so the constraints still
   * decide where everything ends up.
   */
  readonly drag?: { readonly point: SketchEntityId; readonly x: number; readonly y: number };
}

export type SolveStatus = 'solved' | 'converged' | 'failed' | 'invalid';

export interface SolveResult {
  readonly status: SolveStatus;
  /**
   * Remaining degrees of freedom. 0 is fully constrained; the sketcher shows this
   * because "how much of this is pinned down" is the question you are always asking.
   */
  readonly dof: number;
  readonly points: Readonly<Record<SketchEntityId, Vec2>>;
  readonly radii: Readonly<Record<SketchEntityId, number>>;
  /** Constraint ids that contradict each other. Actionable: these are what to delete. */
  readonly conflicting: readonly string[];
  /** Constraint ids that add nothing. Harmless, but worth flagging as clutter. */
  readonly redundant: readonly string[];
  readonly message?: string;
}

/**
 * The 2D constraint solver, behind an interface for the same reason as KernelPort:
 * @cardstock/document must stay free of WASM so the sketch model can be tested in Node.
 */
export interface SolverPort {
  solve(request: SolveRequest): Promise<SolveResult>;
}
