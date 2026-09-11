import type { OrientationOptions, OrientationSuggestion } from '@cardstock/types';
import type { ExportMesh } from './mesh.js';

/**
 * Which way up to print it.
 *
 * Candidates are the directions the part's larger flat regions face — each one put
 * face-down on the bed — plus the six axis directions. Each is scored on what an FDM
 * printer cares about: how much surface overhangs past the limit, how much support
 * would have to be printed under it, how much of the part touches the bed, and how
 * tall it stands. The weights are opinions, stated here so they can be argued with:
 * support volume is what wastes filament and scars the surface, so it dominates.
 */
export type { OrientationOptions, OrientationSuggestion };

type V3 = [number, number, number];
const WEIGHTS = { support: 0.5, overhang: 0.3, height: 0.1, contact: 0.1 };

export function scoreOrientations(mesh: ExportMesh, options: OrientationOptions): OrientationSuggestion[] {
  const triangles = triangleData(mesh);
  if (triangles.length === 0) return [];
  const totalArea = triangles.reduce((a, t) => a + t.area, 0);

  const candidates = candidateDowns(triangles);
  const sinLimit = Math.sin((options.maxOverhangDeg * Math.PI) / 180);
  const scored = candidates.map((down) => {
    const matrix = rotationTaking(down, [0, 0, -1]);
    const rotated = triangles.map((t) => rotateTriangle(t, matrix));
    let zMin = Infinity, zMax = -Infinity;
    for (const t of rotated) for (const v of t.v) { zMin = Math.min(zMin, v[2]); zMax = Math.max(zMax, v[2]); }
    const height = zMax - zMin;
    let overhangArea = 0, supportVolume = 0, contactArea = 0;
    for (const t of rotated) {
      const downness = -t.n[2];
      const zAvg = (t.v[0][2] + t.v[1][2] + t.v[2][2]) / 3;
      const onBed = downness > 0.9 && t.v.every((v) => v[2] - zMin <= options.layer / 2 + 1e-6);
      if (onBed) { contactArea += t.area; continue; }
      if (downness > sinLimit) {
        overhangArea += t.area;
        // Projected footprint times the drop to the bed: the support column.
        supportVolume += t.area * downness * (zAvg - zMin);
      }
    }
    return { down, matrix, overhangArea, supportVolume, contactArea, height };
  });

  // Normalise each metric against the worst candidate so the weights compare likes.
  const max = (f: (s: (typeof scored)[number]) => number) => Math.max(1e-9, ...scored.map(f));
  const maxSupport = max((s) => s.supportVolume), maxHeight = max((s) => s.height);
  const maxContact = max((s) => s.contactArea);
  const out = scored.map((s) => ({
    ...s,
    score:
      WEIGHTS.support * (s.supportVolume / maxSupport)
      + WEIGHTS.overhang * (s.overhangArea / totalArea)
      + WEIGHTS.height * (s.height / maxHeight)
      + WEIGHTS.contact * (1 - s.contactArea / maxContact),
  }));
  out.sort((a, b) => a.score - b.score);
  return out.slice(0, options.limit ?? 3);
}

interface Tri { v: [V3, V3, V3]; n: V3; area: number }

function triangleData(mesh: ExportMesh): Tri[] {
  const p = mesh.positions, i = mesh.indices;
  const out: Tri[] = [];
  for (let t = 0; t < i.length; t += 3) {
    const v = [0, 1, 2].map((k) => {
      const at = i[t + k]! * 3;
      return [p[at]!, p[at + 1]!, p[at + 2]!] as V3;
    }) as [V3, V3, V3];
    const u = sub(v[1], v[0]), w = sub(v[2], v[0]);
    const c = cross(u, w);
    const len = norm(c);
    if (len < 1e-12) continue;
    out.push({ v, n: [c[0] / len, c[1] / len, c[2] / len], area: len / 2 });
  }
  return out;
}

/** Normals of the biggest flat regions, plus the axes. Deduplicated. */
function candidateDowns(triangles: Tri[]): V3[] {
  const buckets = new Map<string, { n: V3; area: number }>();
  for (const t of triangles) {
    // ~6° cells: flat regions of one face land in one bucket, curved surfaces spread.
    const key = t.n.map((c) => Math.round(c * 10)).join(',');
    const b = buckets.get(key);
    if (b) { b.area += t.area; b.n = add(b.n, scale(t.n, t.area)); }
    else buckets.set(key, { n: scale(t.n, t.area), area: t.area });
  }
  const ranked = [...buckets.values()].sort((a, b) => b.area - a.area).slice(0, 8)
    .map((b) => normalise(b.n));
  const axes: V3[] = [[0, 0, -1], [0, 0, 1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]];
  const out: V3[] = [];
  for (const c of [...ranked, ...axes]) {
    if (!out.some((o) => dot(o, c) > 0.999)) out.push(c);
  }
  return out;
}

/** Column-major rotation taking unit vector `from` onto unit vector `to`. */
export function rotationTaking(from: V3, to: V3): number[] {
  const c = dot(from, to);
  let axis = cross(from, to);
  let s = norm(axis);
  let angle = Math.atan2(s, c);
  if (s < 1e-9) {
    if (c > 0) return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    // Opposite: a half turn about any axis perpendicular to `from`.
    axis = Math.abs(from[0]) < 0.9 ? cross(from, [1, 0, 0]) : cross(from, [0, 1, 0]);
    s = norm(axis);
    angle = Math.PI;
  }
  const [x, y, z] = [axis[0] / s, axis[1] / s, axis[2] / s];
  const sa = Math.sin(angle), ca = Math.cos(angle), t = 1 - ca;
  // Rodrigues, written out column-major.
  return [
    t * x * x + ca,     t * x * y + sa * z, t * x * z - sa * y, 0,
    t * x * y - sa * z, t * y * y + ca,     t * y * z + sa * x, 0,
    t * x * z + sa * y, t * y * z - sa * x, t * z * z + ca,     0,
    0, 0, 0, 1,
  ];
}

function rotateTriangle(t: Tri, m: readonly number[]): Tri {
  const r = (v: V3): V3 => [
    m[0]! * v[0] + m[4]! * v[1] + m[8]! * v[2],
    m[1]! * v[0] + m[5]! * v[1] + m[9]! * v[2],
    m[2]! * v[0] + m[6]! * v[1] + m[10]! * v[2],
  ];
  return { v: [r(t.v[0]), r(t.v[1]), r(t.v[2])], n: r(t.n), area: t.area };
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 =>
  [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const normalise = (a: V3): V3 => { const l = norm(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
