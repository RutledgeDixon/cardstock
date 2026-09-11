import { faceNormal, triangleCount, type ExportMesh } from './mesh.js';

/** Binary STL: 80-byte header, uint32 count, then 50 bytes per triangle. */
export function encodeStlBinary(mesh: ExportMesh, name = 'cardstock'): Uint8Array {
  const count = triangleCount(mesh);
  const bytes = new Uint8Array(84 + count * 50);
  const view = new DataView(bytes.buffer);
  // A header that starts with "solid" fools some readers into parsing ASCII; avoid it.
  bytes.set(new TextEncoder().encode(`CARDstock ${name}`.slice(0, 80)));
  view.setUint32(80, count, true);
  const p = mesh.positions;
  const i = mesh.indices;
  let offset = 84;
  for (let t = 0; t < count; t++) {
    const [nx, ny, nz] = faceNormal(mesh, t);
    view.setFloat32(offset, nx, true);
    view.setFloat32(offset + 4, ny, true);
    view.setFloat32(offset + 8, nz, true);
    offset += 12;
    for (let k = 0; k < 3; k++) {
      const v = i[t * 3 + k]! * 3;
      view.setFloat32(offset, p[v]!, true);
      view.setFloat32(offset + 4, p[v + 1]!, true);
      view.setFloat32(offset + 8, p[v + 2]!, true);
      offset += 12;
    }
    view.setUint16(offset, 0, true);
    offset += 2;
  }
  return bytes;
}

export function encodeStlAscii(mesh: ExportMesh, name = 'cardstock'): Uint8Array {
  const p = mesh.positions;
  const i = mesh.indices;
  const lines: string[] = [`solid ${name}`];
  for (let t = 0; t < triangleCount(mesh); t++) {
    const [nx, ny, nz] = faceNormal(mesh, t);
    lines.push(`  facet normal ${nx} ${ny} ${nz}`, '    outer loop');
    for (let k = 0; k < 3; k++) {
      const v = i[t * 3 + k]! * 3;
      lines.push(`      vertex ${p[v]} ${p[v + 1]} ${p[v + 2]}`);
    }
    lines.push('    endloop', '  endfacet');
  }
  lines.push(`endsolid ${name}`, '');
  return new TextEncoder().encode(lines.join('\n'));
}
