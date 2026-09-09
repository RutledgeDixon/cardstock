import { asBodyId, type TessellatedBody } from '@cardstock/types';

/**
 * Loads a checked-in tessellation fixture.
 *
 * Phase 1 develops the viewer against static data; Phase 3 replaces this with the live
 * kernel. Keeping it behind one function means that swap touches a single call site.
 */
interface RawBody {
  bodyId: string;
  positions: number[];
  normals: number[];
  indices: number[];
  triangleFaceId: number[];
  vertexFaceId: number[];
  faceCount: number;
  edgePositions: number[];
  edgeSegmentId: number[];
  edgeCount: number;
  vertexPositions: number[];
  vertexCount: number;
  bounds: TessellatedBody['bounds'];
}

export function toTessellatedBody(raw: RawBody): TessellatedBody {
  return {
    bodyId: asBodyId(raw.bodyId),
    positions: new Float32Array(raw.positions),
    normals: new Float32Array(raw.normals),
    indices: new Uint32Array(raw.indices),
    triangleFaceId: new Uint32Array(raw.triangleFaceId),
    vertexFaceId: new Float32Array(raw.vertexFaceId),
    faceCount: raw.faceCount,
    edgePositions: new Float32Array(raw.edgePositions),
    edgeSegmentId: new Uint32Array(raw.edgeSegmentId),
    edgeCount: raw.edgeCount,
    vertexPositions: new Float32Array(raw.vertexPositions),
    vertexCount: raw.vertexCount,
    bounds: raw.bounds,
  };
}

export async function loadFixture(url: string): Promise<TessellatedBody> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fixture ${url}: ${res.status}`);
  return toTessellatedBody((await res.json()) as RawBody);
}
