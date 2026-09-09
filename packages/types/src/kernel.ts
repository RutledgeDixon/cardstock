import type { Bounds, Vec3 } from './geometry.js';
import type { TessellatedBody, TessellationQuality } from './tessellation.js';
import type { BodyId } from './ids.js';
import type { ProfileSpec } from './sketch.js';

/**
 * The geometry contract.
 *
 * @cardstock/document talks to this and never to OCCT. That single rule is what keeps
 * the recompute engine and topological naming testable in Node against a MockKernel,
 * which is the only realistic way to get them correct. @cardstock/kernel implements it
 * over OCCT in a Web Worker.
 *
 * Every operation is async because the real implementation is behind a worker boundary.
 */

/** An opaque reference to a shape living inside the kernel. Never inspect it. */
export type ShapeHandle = string & { readonly __brand: 'ShapeHandle' };

/** 4x4 column-major transform. */
export type Matrix4 = readonly number[];

export interface BoxSpec { dx: number; dy: number; dz: number; origin?: Vec3 }
export interface CylinderSpec { radius: number; height: number; origin?: Vec3; axis?: Vec3 }
export interface SphereSpec { radius: number; origin?: Vec3 }

export type BooleanOp = 'union' | 'cut' | 'intersect';

/**
 * How sub-shapes of the inputs map onto sub-shapes of the result.
 *
 * This is OCCT's Generated/Modified/IsDeleted, normalised. Phase 2 only carries it
 * through; Phase 4's topological naming is what consumes it. Capturing it from the
 * start means the port does not have to change when naming lands.
 */
export interface InputHistory {
  /** input face index -> result face indices it became. Absent = unchanged. */
  readonly modifiedFaces: ReadonlyMap<number, readonly number[]>;
  /** input edge index -> result edge indices it became. Absent = unchanged. */
  readonly modifiedEdges: ReadonlyMap<number, readonly number[]>;
  /** input edge index -> result face indices it generated (e.g. a fillet surface). */
  readonly generatedFaces: ReadonlyMap<number, readonly number[]>;
  /** input face indices that no longer exist in the result. */
  readonly deletedFaces: readonly number[];
  /** input edge indices that no longer exist in the result. */
  readonly deletedEdges: readonly number[];
}

export interface ShapeHistory {
  /**
   * One entry per input shape, in the order the operation received them.
   *
   * Per-input rather than one flat map, because sub-shape indices are only meaningful
   * relative to their own shape: face 0 of a box and face 0 of the cylinder cutting it
   * are unrelated, and merging them silently loses half the history.
   */
  readonly inputs: readonly InputHistory[];
}

export interface GeometryResult {
  readonly handle: ShapeHandle;
  /** Present when the operation had inputs; root primitives have none. */
  readonly history?: ShapeHistory;
}

export interface MassProperties {
  readonly volume: number;
  readonly surfaceArea: number;
  readonly centreOfMass: Vec3;
}

/** Counts of each topological entity kind, for regression fixtures. */
export interface TopologyCounts {
  readonly faces: number;
  readonly edges: number;
  readonly vertices: number;
}

/**
 * What one topological entity looks like, for re-identifying it after a rebuild.
 *
 * Coordinates are normalised against the shape's bounding box. That is the key choice:
 * a corner edge of a box sits at bbox-fraction (0, 0, *) whether the box is 40mm or 55mm
 * wide, so the fingerprint is invariant to exactly the edit that breaks index-based
 * references. See docs/toponaming.md.
 */
export interface EntityFingerprint {
  readonly kind: 'face' | 'edge' | 'vertex';
  /** Index within the shape at the time of capture. A cache, never a durable identity. */
  readonly index: number;
  /** 'plane' | 'cylinder' | 'line' | 'circle' | ... — a hard filter, never a score. */
  readonly geometryType: string;
  /** Position within the bounding box, each axis in 0..1. */
  readonly centroidNormalised: Vec3;
  /** Raw model-space centroid, for diagnostics and repair UI. */
  readonly centroid: Vec3;
  /** Face normal, or edge axis/tangent. Null for vertices. */
  readonly direction: Vec3 | null;
  /** Area or length as a fraction of the shape's total. Robust to scaling. */
  readonly measureRatio: number;
  /** Raw area or length. */
  readonly measure: number;
  /** Sorted geometry types of adjacent faces; distinguishes lookalikes. */
  readonly neighbourTypes: readonly string[];
}

export interface ShapeDescription {
  readonly faces: readonly EntityFingerprint[];
  readonly edges: readonly EntityFingerprint[];
  readonly vertices: readonly EntityFingerprint[];
  readonly bounds: Bounds;
}

export interface KernelPort {
  makeBox(spec: BoxSpec): Promise<GeometryResult>;
  makeCylinder(spec: CylinderSpec): Promise<GeometryResult>;
  makeSphere(spec: SphereSpec): Promise<GeometryResult>;

  /** Build a planar face from a closed profile: first loop outer, the rest holes. */
  makeFace(profile: ProfileSpec): Promise<GeometryResult>;
  /**
   * Build a wire from a profile's first loop, whether or not it closes.
   *
   * A sweep path is a sketch that was never meant to close, so it cannot become a face.
   */
  makePath(profile: ProfileSpec): Promise<GeometryResult>;
  /** Sweep a face along its normal. Negative distance extrudes the other way. */
  extrude(shape: ShapeHandle, distance: number, symmetric?: boolean): Promise<GeometryResult>;

  /** Sweep a profile around an axis. `angle` in degrees; 360 makes a full solid. */
  revolve(
    shape: ShapeHandle,
    axis: { origin: Vec3; direction: Vec3 },
    angle: number,
  ): Promise<GeometryResult>;

  /**
   * Sweep a profile along a path taken from another shape.
   *
   * The path may be a wire, an edge, or a face whose outer boundary is the path — a
   * sketch drawn to be followed is not prepared differently from one to be swept.
   */
  sweep(profile: ShapeHandle, path: ShapeHandle): Promise<GeometryResult>;

  /** Blend a run of profiles into one solid, in the order given. */
  loft(
    profiles: readonly ShapeHandle[],
    options?: { ruled?: boolean },
  ): Promise<GeometryResult>;

  /**
   * Taper faces away from a neutral plane, by degrees.
   *
   * `pull` is the direction matter is removed from — for a printed part, the build
   * direction. Only planar, cylindrical and conical faces can be tapered.
   */
  draft(
    shape: ShapeHandle,
    faces: readonly number[],
    angle: number,
    pull: Vec3,
    neutralPlane: { origin: Vec3; normal: Vec3 },
  ): Promise<GeometryResult>;

  /**
   * Hollow a solid, removing the named faces to leave openings.
   *
   * Negative thickness offsets inward, which is what "wall thickness" means for a
   * printed part; positive grows it outward.
   */
  shell(
    shape: ShapeHandle,
    openFaces: readonly number[],
    thickness: number,
  ): Promise<GeometryResult>;

  /** Reflect through a plane. */
  mirror(
    shape: ShapeHandle,
    plane: { origin: Vec3; normal: Vec3 },
  ): Promise<GeometryResult>;

  boolean(op: BooleanOp, base: ShapeHandle, tool: ShapeHandle): Promise<GeometryResult>;
  fillet(shape: ShapeHandle, edges: readonly number[], radius: number): Promise<GeometryResult>;
  chamfer(shape: ShapeHandle, edges: readonly number[], distance: number): Promise<GeometryResult>;
  transform(shape: ShapeHandle, matrix: Matrix4): Promise<GeometryResult>;

  tessellate(
    shape: ShapeHandle,
    bodyId: BodyId,
    quality: TessellationQuality,
  ): Promise<TessellatedBody>;

  massProperties(shape: ShapeHandle): Promise<MassProperties>;
  /** Fingerprints for every sub-shape. Drives topological naming (Phase 4). */
  describeShape(shape: ShapeHandle): Promise<ShapeDescription>;
  boundingBox(shape: ShapeHandle): Promise<Bounds>;
  topologyCounts(shape: ShapeHandle): Promise<TopologyCounts>;

  /** Tessellate and encode as STL. Binary by default; ASCII is for debugging. */
  exportStl(
    shape: ShapeHandle,
    options?: { quality?: TessellationQuality; binary?: boolean },
  ): Promise<Uint8Array>;

  /** Drop a handle. The kernel refcounts; the document releases what it evicts. */
  release(shape: ShapeHandle): Promise<void>;
}

/** Thrown by a kernel implementation when an operation fails on valid-looking input. */
export class KernelError extends Error {
  constructor(message: string, readonly operation: string) {
    super(message);
    this.name = 'KernelError';
  }
}
