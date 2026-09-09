import type { BodyId } from './ids.js';
import type { Bounds } from './geometry.js';

/**
 * A tessellated body: everything the viewer needs to draw and pick one solid.
 *
 * Produced by @cardstock/kernel, consumed by @cardstock/viewer. Typed arrays so the
 * whole thing can be transferred from the worker without a copy.
 *
 * The `*Id` arrays are what make right-clicking a face meaningful: they map rendered
 * primitives back to OCCT topology. See docs/adr/0002 for the BVH reordering trap that
 * makes the triangle mapping subtler than it looks.
 */
export interface TessellatedBody {
  readonly bodyId: BodyId;

  // --- surface ---
  /** xyz per vertex. */
  readonly positions: Float32Array;
  /** Unit normals, one per vertex, already flipped for REVERSED faces. */
  readonly normals: Float32Array;
  /** Triangle vertex indices, 3 per triangle. */
  readonly indices: Uint32Array;
  /** Originating OCCT face index, one entry per TRIANGLE. */
  readonly triangleFaceId: Uint32Array;
  /** Same value per VERTEX — an independent path to the face id that survives
   *  index-buffer reordering by the BVH builder. Also drives the hover shader. */
  readonly vertexFaceId: Float32Array;
  readonly faceCount: number;

  // --- edges (drawn as line segments; CAD reads as edges, not triangles) ---
  /** Pairs of xyz, 6 floats per segment. */
  readonly edgePositions: Float32Array;
  /** Originating OCCT edge index, one entry per SEGMENT. */
  readonly edgeSegmentId: Uint32Array;
  readonly edgeCount: number;

  // --- topological vertices ---
  /** xyz per topological vertex, in OCCT traversal order. */
  readonly vertexPositions: Float32Array;
  readonly vertexCount: number;

  readonly bounds: Bounds;
}

/** Tessellation quality. Lower deflection = more triangles = slower. */
export interface TessellationQuality {
  /** Max deviation between the mesh and the true surface, in mm. */
  readonly linearDeflection: number;
  /** Max angle between adjacent facet normals, in radians. */
  readonly angularDeflection: number;
}

/** Fast enough to feel live while scrubbing a parameter. */
export const DISPLAY_QUALITY: TessellationQuality = {
  linearDeflection: 0.05,
  angularDeflection: 0.35,
};

/** For STL and friends — export re-tessellates rather than reusing the display mesh. */
export const EXPORT_QUALITY: TessellationQuality = {
  linearDeflection: 0.01,
  angularDeflection: 0.2,
};
