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

import type { Vec3 } from './geometry.js';

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
  /**
   * Projected from outside the sketch — a vertex of the face it sits on, the end of an
   * origin axis. Keyed so it can be re-projected when the body underneath changes.
   * External geometry is fixed, cannot be deleted, and is never part of a profile; it
   * exists to be constrained against.
   */
  readonly external?: string;
}

export interface SketchLine {
  readonly id: SketchEntityId;
  readonly type: 'line';
  readonly p1: SketchEntityId;
  readonly p2: SketchEntityId;
  /** Reference geometry: solved and drawn, but never part of a profile. */
  readonly construction?: boolean;
  /** See SketchPoint.external. */
  readonly external?: string;
}

export interface SketchCircle {
  readonly id: SketchEntityId;
  readonly type: 'circle';
  readonly centre: SketchEntityId;
  readonly radius: number;
  readonly construction?: boolean;
  /** See SketchPoint.external. The radius is locked as well as the centre. */
  readonly external?: string;
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
  /** Arcs are never external; present so every geometry kind can be asked. */
  readonly external?: undefined;
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
  | ({ readonly type: 'distance'; readonly a: SketchEntityId; readonly b: SketchEntityId } & DimensionalBase)
  | ({ readonly type: 'pointLineDistance'; readonly point: SketchEntityId; readonly line: SketchEntityId } & DimensionalBase)
  /** Between two parallel lines: the gap, measured from `a`'s start to `b`. */
  | ({ readonly type: 'lineLineDistance'; readonly a: SketchEntityId; readonly b: SketchEntityId } & DimensionalBase)
  /** From a circle's rim to a line. */
  | ({ readonly type: 'circleLineDistance'; readonly circle: SketchEntityId; readonly line: SketchEntityId } & DimensionalBase)
  /** From a point to a circle's rim. */
  | ({ readonly type: 'pointCircleDistance'; readonly point: SketchEntityId; readonly circle: SketchEntityId } & DimensionalBase)
  | ({ readonly type: 'radius'; readonly entity: SketchEntityId } & DimensionalBase)
  /** How far round an arc goes, in degrees, counter-clockwise from its start. */
  | ({ readonly type: 'arcAngle'; readonly entity: SketchEntityId } & DimensionalBase)
  | ({ readonly type: 'diameter'; readonly entity: SketchEntityId } & DimensionalBase)
  | ({ readonly type: 'angle'; readonly a: SketchEntityId; readonly b: SketchEntityId } & DimensionalBase)
  | ({ readonly type: 'lockX'; readonly point: SketchEntityId } & DimensionalBase)
  | ({ readonly type: 'lockY'; readonly point: SketchEntityId } & DimensionalBase);

/**
 * What every dimension carries.
 *
 * A `reference` dimension only reports: it is drawn, it follows the geometry, and it
 * takes no freedom away. Typing a value into it makes it driving. That is how a
 * dimension can be placed to SEE a length without pinning the sketch down by accident.
 */
export interface DimensionalBase {
  readonly id: string;
  readonly value: Dimension;
  readonly reference?: boolean;
}

export type SketchConstraintType = SketchConstraint['type'];

/**
 * A constraint before it has an id.
 *
 * Distributive: a plain `Omit<SketchConstraint, 'id'>` collapses the union to the keys
 * every member shares, which is just `type`, so every other field becomes an error.
 */
export type NewSketchConstraint =
  SketchConstraint extends infer T
    ? T extends { id: string } ? Omit<T, 'id'> : never
    : never;

/** Constraints carrying a numeric value, which the UI shows as an editable dimension. */
export const DIMENSIONAL_CONSTRAINTS: readonly SketchConstraintType[] = [
  'distance', 'pointLineDistance', 'lineLineDistance', 'circleLineDistance', 'pointCircleDistance',
  'radius', 'diameter', 'angle', 'arcAngle', 'lockX', 'lockY',
];

export const isDimensional = (type: SketchConstraintType): boolean =>
  DIMENSIONAL_CONSTRAINTS.includes(type);

/**
 * The boundary of a face, in 3D, for projecting into a sketch on it.
 *
 * Only what a sketch can constrain against is described: straight edges as their two
 * ends, circular edges as centre and radius (with the ends, for arcs). Anything else is
 * reported by its ends alone.
 */
export type OutlineEdge =
  | { readonly kind: 'line'; readonly from: Vec3; readonly to: Vec3 }
  | { readonly kind: 'circle'; readonly centre: Vec3; readonly radius: number; readonly from: Vec3; readonly to: Vec3; readonly closed: boolean }
  | { readonly kind: 'other'; readonly from: Vec3; readonly to: Vec3 };

export interface FaceOutline {
  readonly edges: readonly OutlineEdge[];
}

// ---------------------------------------------------------------- profiles

/** Where a sketch plane sits in 3D. `xAxis` fixes the in-plane rotation. */
export interface PlanePlacement {
  readonly origin: { readonly x: number; readonly y: number; readonly z: number };
  readonly normal: { readonly x: number; readonly y: number; readonly z: number };
  readonly xAxis: { readonly x: number; readonly y: number; readonly z: number };
}

/** One piece of a closed boundary, in sketch-plane coordinates. */
export type ProfileSegment =
  | { readonly kind: 'line'; readonly from: Vec2; readonly to: Vec2 }
  | {
      readonly kind: 'arc'; readonly centre: Vec2; readonly radius: number;
      readonly from: Vec2; readonly to: Vec2;
      readonly startAngle: number; readonly endAngle: number;
    }
  | { readonly kind: 'circle'; readonly centre: Vec2; readonly radius: number };

export interface ProfileLoopSpec {
  readonly segments: readonly ProfileSegment[];
  /** Shoelace area; its sign gives the winding direction. */
  readonly signedArea: number;
}

/**
 * A closed profile ready to become a face.
 *
 * The first loop is the outer boundary; the rest are holes. The kernel does not work
 * that out for itself, because deciding which loop encloses which is a modelling
 * question, not a geometry one.
 */
export interface ProfileSpec {
  readonly placement: PlanePlacement;
  readonly loops: readonly ProfileLoopSpec[];
  /**
   * Further faces on the same plane, each given as outer loop then holes.
   *
   * A sketch may enclose several separate regions — two triangles sharing a corner —
   * and each becomes its own face; the result is a compound, and extruding it makes
   * one body per region.
   */
  readonly regions?: readonly (readonly ProfileLoopSpec[])[];
}

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
  /** Solved arc extents, radians counter-clockwise. */
  readonly angles?: Readonly<Record<SketchEntityId, { readonly start: number; readonly end: number }>>;
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
