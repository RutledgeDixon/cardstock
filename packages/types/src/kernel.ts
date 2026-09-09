import type { Bounds, Vec3 } from './geometry.js';
import type { TessellatedBody, TessellationQuality } from './tessellation.js';
import type { BodyId } from './ids.js';

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
  /** input edge index -> result face indices it generated (e.g. a fillet surface). */
  readonly generatedFaces: ReadonlyMap<number, readonly number[]>;
  /** input face indices that no longer exist in the result. */
  readonly deletedFaces: readonly number[];
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

export interface KernelPort {
  makeBox(spec: BoxSpec): Promise<GeometryResult>;
  makeCylinder(spec: CylinderSpec): Promise<GeometryResult>;
  makeSphere(spec: SphereSpec): Promise<GeometryResult>;

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
  boundingBox(shape: ShapeHandle): Promise<Bounds>;
  topologyCounts(shape: ShapeHandle): Promise<TopologyCounts>;

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
