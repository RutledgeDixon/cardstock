import { triangleCount, type ExportMesh } from './mesh.js';
import { zipStore } from './zip.js';

/**
 * 3MF: the format a slicer would rather have than STL.
 *
 * It carries units, so "is this in inches?" never comes up, and its mesh is indexed,
 * so the welded topology survives into the slicer instead of being reconstructed by
 * guesswork. This writes the core spec only — one object, one build item, no colours or
 * materials — which every slicer reads.
 */
export function encode3mf(mesh: ExportMesh, name = 'cardstock'): Uint8Array {
  const encoder = new TextEncoder();
  const p = mesh.positions;
  const i = mesh.indices;

  const parts: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
    '  <metadata name="Application">CARDstock</metadata>',
    `  <metadata name="Title">${escapeXml(name)}</metadata>`,
    '  <resources>',
    `    <object id="1" name="${escapeXml(name)}" type="model">`,
    '      <mesh>',
    '        <vertices>',
  ];
  for (let v = 0; v < p.length; v += 3) {
    parts.push(`          <vertex x="${p[v]}" y="${p[v + 1]}" z="${p[v + 2]}"/>`);
  }
  parts.push('        </vertices>', '        <triangles>');
  for (let t = 0; t < triangleCount(mesh); t++) {
    parts.push(`          <triangle v1="${i[t * 3]}" v2="${i[t * 3 + 1]}" v3="${i[t * 3 + 2]}"/>`);
  }
  parts.push(
    '        </triangles>', '      </mesh>', '    </object>', '  </resources>',
    '  <build>', '    <item objectid="1"/>', '  </build>', '</model>', '',
  );

  const contentTypes = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>',
    '</Types>', '',
  ].join('\n');

  const rels = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>',
    '</Relationships>', '',
  ].join('\n');

  return zipStore([
    { name: '[Content_Types].xml', data: encoder.encode(contentTypes) },
    { name: '_rels/.rels', data: encoder.encode(rels) },
    { name: '3D/3dmodel.model', data: encoder.encode(parts.join('\n')) },
  ]);
}

const escapeXml = (s: string) =>
  s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
