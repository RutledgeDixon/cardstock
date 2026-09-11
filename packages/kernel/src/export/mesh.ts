/**
 * The mesh an export writes: welded, indexed, triangles only.
 *
 * The tessellator produces one vertex run per B-rep face, so a vertex on a shared edge
 * exists once for each face that meets there. STL does not care — it has no notion of a
 * shared vertex — but 3MF and OBJ do: a slicer reading duplicated vertices sees an open
 * shell along every edge and "repairs" it, sometimes wrongly. Welding merges those
 * duplicates by position so the exported mesh is topologically closed as well as
 * geometrically.
 */
export interface ExportMesh {
  /** xyz per vertex. */
  readonly positions: Float32Array;
  /** 3 per triangle, counter-clockwise seen from outside. */
  readonly indices: Uint32Array;
}

/** Positions are matched to this many decimal places; well under any print tolerance. */
const WELD_DECIMALS = 4;

export function weld(positions: ArrayLike<number>, indices: ArrayLike<number>): ExportMesh {
  const scale = 10 ** WELD_DECIMALS;
  const remap = new Uint32Array(positions.length / 3);
  const byKey = new Map<string, number>();
  const welded: number[] = [];

  for (let v = 0; v < remap.length; v++) {
    const x = Math.round(positions[v * 3]! * scale) / scale;
    const y = Math.round(positions[v * 3 + 1]! * scale) / scale;
    const z = Math.round(positions[v * 3 + 2]! * scale) / scale;
    const key = `${x},${y},${z}`;
    let index = byKey.get(key);
    if (index === undefined) {
      index = welded.length / 3;
      byKey.set(key, index);
      welded.push(x, y, z);
    }
    remap[v] = index;
  }

  const out: number[] = [];
  for (let t = 0; t < indices.length; t += 3) {
    const a = remap[indices[t]!]!;
    const b = remap[indices[t + 1]!]!;
    const c = remap[indices[t + 2]!]!;
    // A triangle whose corners welded together has no area; keep the file honest.
    if (a === b || b === c || a === c) continue;
    out.push(a, b, c);
  }
  return { positions: Float32Array.from(welded), indices: Uint32Array.from(out) };
}

export const triangleCount = (mesh: ExportMesh) => mesh.indices.length / 3;

/** Unit normal of one triangle, for formats that store it per facet. */
export function faceNormal(mesh: ExportMesh, triangle: number): [number, number, number] {
  const p = mesh.positions;
  const i = mesh.indices;
  const a = i[triangle * 3]! * 3;
  const b = i[triangle * 3 + 1]! * 3;
  const c = i[triangle * 3 + 2]! * 3;
  const ux = p[b]! - p[a]!, uy = p[b + 1]! - p[a + 1]!, uz = p[b + 2]! - p[a + 2]!;
  const vx = p[c]! - p[a]!, vy = p[c + 1]! - p[a + 1]!, vz = p[c + 2]! - p[a + 2]!;
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

/** Signed volume by the divergence theorem: positive for an outward-wound closed mesh. */
export function signedVolume(mesh: ExportMesh): number {
  const p = mesh.positions;
  const i = mesh.indices;
  let six = 0;
  for (let t = 0; t < i.length; t += 3) {
    const a = i[t]! * 3, b = i[t + 1]! * 3, c = i[t + 2]! * 3;
    six += p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!)
         - p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!)
         + p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!);
  }
  return six / 6;
}

/**
 * True when every edge is shared by exactly two triangles with opposite direction —
 * the definition of a closed, consistently wound surface. What a slicer checks first.
 */
export function isWatertight(mesh: ExportMesh): boolean {
  const seen = new Map<string, number>();
  const i = mesh.indices;
  for (let t = 0; t < i.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const from = i[t + k]!, to = i[t + ((k + 1) % 3)]!;
      const key = `${from}>${to}`;
      if (seen.has(key)) return false; // same directed edge twice: overlapping or flipped
      seen.set(key, 1);
    }
  }
  for (const key of seen.keys()) {
    const [from, to] = key.split('>');
    if (!seen.has(`${to}>${from}`)) return false; // no partner: an open edge
  }
  return true;
}
