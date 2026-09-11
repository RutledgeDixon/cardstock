import { triangleCount, type ExportMesh } from './mesh.js';

/** Wavefront OBJ: one object, positions and faces, 1-based indices. Units are a comment. */
export function encodeObj(mesh: ExportMesh, name = 'cardstock'): Uint8Array {
  const p = mesh.positions;
  const i = mesh.indices;
  const lines: string[] = ['# CARDstock export, millimetres', `o ${name}`];
  for (let v = 0; v < p.length; v += 3) lines.push(`v ${p[v]} ${p[v + 1]} ${p[v + 2]}`);
  for (let t = 0; t < triangleCount(mesh); t++) {
    lines.push(`f ${i[t * 3]! + 1} ${i[t * 3 + 1]! + 1} ${i[t * 3 + 2]! + 1}`);
  }
  lines.push('');
  return new TextEncoder().encode(lines.join('\n'));
}
