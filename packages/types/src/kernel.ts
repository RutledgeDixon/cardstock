import type { Bounds, Vec3 } from './geometry.js';
import type { TessellatedBody, TessellationQuality } from './tessellation.js';
import type { BodyId } from './ids.js';
import type { FaceOutline, ProfileSpec } from './sketch.js';

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
  /**
   * Sorted area ratios of the adjacent faces (edges only). An inner and an outer
   * wall edge look alike in every other way; the wall they belong to does not.
   */
  readonly neighbourMeasures?: readonly number[];
  /** 1/radius for cylindrical faces and circular edges; 0 for flat and straight. */
  readonly curvature?: number;
  /**
   * Distance from the shape's centre, as a fraction of its half-diagonal. Tells an
   * outer wall from an inner one even when a stretch has shifted everything's place
   * in the bounding box: outer stays further out.
   */
  readonly radialNormalised?: number;
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

  /**
   * Gather several shapes into one without fusing them.
   *
   * Exporting a part made of separate bodies needs this; fusing would change geometry
   * where bodies merely touch.
   */
  compound(shapes: readonly ShapeHandle[]): Promise<GeometryResult>;

  boolean(op: BooleanOp, base: ShapeHandle, tool: ShapeHandle): Promise<GeometryResult>;
  /**
   * One boolean against many tools at once.
   *
   * Sequential pairwise booleans are O(n^2): each one re-solves the intersection graph
   * of everything already combined. Use this wherever the tools are known up front.
   */
  booleanMany(
    op: BooleanOp, base: ShapeHandle, tools: readonly ShapeHandle[],
  ): Promise<GeometryResult>;
  fillet(shape: ShapeHandle, edges: readonly number[], radius: number): Promise<GeometryResult>;
  chamfer(shape: ShapeHandle, edges: readonly number[], distance: number): Promise<GeometryResult>;
  transform(shape: ShapeHandle, matrix: Matrix4): Promise<GeometryResult>;
  /**
   * Apply several transforms to one shape in a single call.
   *
   * The kernel is behind a worker boundary, so a hundred one-at-a-time transforms is a
   * hundred round trips before any geometry is built.
   */
  transformMany(shape: ShapeHandle, matrices: readonly Matrix4[]): Promise<GeometryResult[]>;

  tessellate(
    shape: ShapeHandle,
    bodyId: BodyId,
    quality: TessellationQuality,
  ): Promise<TessellatedBody>;

  /**
   * Start recording allocations, so intermediates can be freed together.
   *
   * OCCT objects are manually managed, and a feature typically allocates several shapes
   * on the way to the one it returns. Scoping is how those get freed without every
   * feature having to remember.
   */
  /**
   * Live shape count — an otherwise invisible number.
   *
   * OCCT objects are manually managed, so a leak shows up here as a count that climbs
   * and never settles. Under repeated edits it should plateau at the cache limit.
   */
  stats(): Promise<{ shapes: number }>;

  beginScope(): Promise<void>;
  /** Free everything allocated since `beginScope`, except `keep`. Returns the count. */
  endScope(keep: readonly ShapeHandle[]): Promise<number>;

  massProperties(shape: ShapeHandle): Promise<MassProperties>;
  /** The edges bounding one face, for a sketch on it to constrain against. */
  faceOutline(shape: ShapeHandle, faceIndex: number): Promise<FaceOutline>;
  /** Fingerprints for every sub-shape. Drives topological naming (Phase 4). */
  describeShape(shape: ShapeHandle): Promise<ShapeDescription>;
  boundingBox(shape: ShapeHandle): Promise<Bounds>;
  topologyCounts(shape: ShapeHandle): Promise<TopologyCounts>;

  /** Tessellate and encode as STL. Binary by default; ASCII is for debugging. */
  exportStl(
    shape: ShapeHandle,
    options?: { quality?: TessellationQuality; binary?: boolean },
  ): Promise<Uint8Array>;

  /**
   * Encode a shape for another program.
   *
   * Mesh formats re-tessellate at the quality given — export quality by default, never
   * the display mesh — and weld the result so it is closed as a mesh, not just as
   * geometry. STEP writes the B-rep itself and ignores quality.
   */
  exportModel(
    shape: ShapeHandle,
    format: ExportFormat,
    options?: ExportOptions,
  ): Promise<ExportResult>;

  /** What a mesh export at this quality would contain, without writing it. */
  meshStats(shape: ShapeHandle, quality: TessellationQuality): Promise<MeshStats>;

  /**
   * Which way up to print it: the best few orientations, scored for an FDM printer.
   *
   * Runs on a coarse mesh; the numbers are estimates for ranking, not for quoting.
   */
  scoreOrientations(shape: ShapeHandle, options: OrientationOptions): Promise<OrientationSuggestion[]>;

  /** Read a STEP file's contents into a shape. Units are converted to millimetres. */
  importStep(text: string): Promise<GeometryResult>;
  /**
   * Read an STL into a solid.
   *
   * Every triangle becomes a face and the faces are sewn into a shell, so a large mesh
   * is slow and a huge one is refused; STL is imported to model against, not to edit.
   */
  importStl(bytes: Uint8Array): Promise<GeometryResult>;

  /** Drop a handle. The kernel refcounts; the document releases what it evicts. */
  release(shape: ShapeHandle): Promise<void>;
}

export type ExportFormat = 'stl' | 'stl-ascii' | '3mf' | 'obj' | 'step';

export interface ExportOptions {
  readonly quality?: TessellationQuality;
  /** Object name written into formats that carry one. */
  readonly name?: string;
}

export interface ExportResult {
  readonly bytes: Uint8Array;
  /** Triangles written; 0 for STEP, which has none. */
  readonly triangles: number;
}

export interface OrientationOptions {
  /** Degrees from vertical past which a surface needs support. */
  readonly maxOverhangDeg: number;
  /** Layer height, mm. */
  readonly layer: number;
  readonly limit?: number;
}

export interface OrientationSuggestion {
  /** Unit vector in the part's own frame that ends up pointing down. */
  readonly down: readonly [number, number, number];
  /** Column-major 4x4 rotation taking the part into that orientation. */
  readonly matrix: readonly number[];
  readonly overhangArea: number;
  readonly supportVolume: number;
  readonly contactArea: number;
  readonly height: number;
  /** Lower is better; 0 is a part with nothing to complain about. */
  readonly score: number;
}

export interface MeshStats {
  readonly triangles: number;
  readonly vertices: number;
  /** Closed and consistently wound — what a slicer checks before anything else. */
  readonly watertight: boolean;
}

/** File extension and MIME type per export format, for whoever writes the file. */
export const EXPORT_FORMATS: Readonly<Record<ExportFormat, {
  readonly label: string; readonly extension: string; readonly mime: string; readonly mesh: boolean;
}>> = {
  'stl': { label: 'STL (binary)', extension: '.stl', mime: 'model/stl', mesh: true },
  'stl-ascii': { label: 'STL (ASCII)', extension: '.stl', mime: 'model/stl', mesh: true },
  '3mf': { label: '3MF', extension: '.3mf', mime: 'model/3mf', mesh: true },
  'obj': { label: 'OBJ', extension: '.obj', mime: 'model/obj', mesh: true },
  'step': { label: 'STEP', extension: '.step', mime: 'model/step', mesh: false },
};

/** Thrown by a kernel implementation when an operation fails on valid-looking input. */
export class KernelError extends Error {
  constructor(message: string, readonly operation: string) {
    super(message);
    this.name = 'KernelError';
  }
}
