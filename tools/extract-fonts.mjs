/**
 * Pull glyph outlines out of TrueType files into compact JSON the app can embed.
 *
 * Text has to become real geometry — closed loops a kernel can make faces from — and
 * this OCCT build has no font support at all (no Font_BRepFont), so the outlines have
 * to come from somewhere else. Extracting them here, once, beats shipping font binaries
 * and a TTF parser to every user: the app gets a few tens of KB of integers per face,
 * loads nothing at runtime, and the document layer stays pure and testable in Node.
 *
 * Only printable ASCII is extracted. That is what a printed part is labelled with, and
 * the whole of DejaVu would be megabytes.
 *
 * Run: node tools/extract-fonts.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'packages/document/src/features');

/** The five faces offered, each permissively licensed and present on Debian/Ubuntu. */
const FACES = [
  { key: 'sans', name: 'Sans', file: '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf' },
  { key: 'serif', name: 'Serif', file: '/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf' },
  { key: 'mono', name: 'Mono', file: '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf' },
  { key: 'condensed', name: 'Condensed', file: '/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed.ttf' },
  { key: 'round', name: 'Round', file: '/usr/share/fonts/truetype/ubuntu/Ubuntu-R.ttf' },
];

// ---------------------------------------------------------------- TTF reading
class Reader {
  constructor(buffer, offset = 0) { this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength); this.at = offset; }
  u8() { return this.view.getUint8(this.at++); }
  i8() { return this.view.getInt8(this.at++); }
  u16() { const v = this.view.getUint16(this.at); this.at += 2; return v; }
  i16() { const v = this.view.getInt16(this.at); this.at += 2; return v; }
  u32() { const v = this.view.getUint32(this.at); this.at += 4; return v; }
  tag() { return String.fromCharCode(this.u8(), this.u8(), this.u8(), this.u8()); }
}

function tables(buffer) {
  const r = new Reader(buffer);
  r.u32(); // version
  const count = r.u16();
  r.u16(); r.u16(); r.u16();
  const found = {};
  for (let i = 0; i < count; i++) {
    const tag = r.tag();
    r.u32(); // checksum
    const offset = r.u32();
    const length = r.u32();
    found[tag] = { offset, length };
  }
  return found;
}

/** cmap format 4: the Basic Multilingual Plane table every Latin font carries. */
function readCmap(buffer, offset) {
  const r = new Reader(buffer, offset);
  r.u16(); // version
  const numTables = r.u16();
  let best = -1;
  for (let i = 0; i < numTables; i++) {
    const platform = r.u16(), encoding = r.u16(), sub = r.u32();
    // Windows Unicode BMP, or Unicode platform: either gives us ASCII.
    if ((platform === 3 && encoding === 1) || platform === 0) best = offset + sub;
  }
  if (best < 0) throw new Error('no unicode cmap');

  const c = new Reader(buffer, best);
  const format = c.u16();
  if (format !== 4) throw new Error(`cmap format ${format} not supported`);
  c.u16(); c.u16(); // length, language
  const segCount = c.u16() / 2;
  c.u16(); c.u16(); c.u16(); // searchRange, entrySelector, rangeShift
  const ends = [], starts = [], deltas = [], rangeOffsets = [], rangeOffsetAt = [];
  for (let i = 0; i < segCount; i++) ends.push(c.u16());
  c.u16(); // reservedPad
  for (let i = 0; i < segCount; i++) starts.push(c.u16());
  for (let i = 0; i < segCount; i++) deltas.push(c.i16());
  for (let i = 0; i < segCount; i++) { rangeOffsetAt.push(c.at); rangeOffsets.push(c.u16()); }

  return (code) => {
    for (let i = 0; i < segCount; i++) {
      if (code > ends[i] || code < starts[i]) continue;
      if (rangeOffsets[i] === 0) return (code + deltas[i]) & 0xffff;
      const at = rangeOffsetAt[i] + rangeOffsets[i] + (code - starts[i]) * 2;
      const g = new Reader(buffer, at).u16();
      return g === 0 ? 0 : (g + deltas[i]) & 0xffff;
    }
    return 0;
  };
}

function readLoca(buffer, offset, numGlyphs, longFormat) {
  const r = new Reader(buffer, offset);
  const out = [];
  for (let i = 0; i <= numGlyphs; i++) out.push(longFormat ? r.u32() : r.u16() * 2);
  return out;
}

/**
 * One glyph's contours, as TrueType stores them: points that are either ON the outline
 * or control points of a quadratic curve. Two consecutive control points imply an
 * on-curve point midway between them, which is how the format saves space.
 */
function readGlyph(buffer, glyf, loca, index, depth = 0) {
  if (depth > 4) return [];
  const start = glyf.offset + loca[index];
  if (loca[index] === loca[index + 1]) return []; // blank, e.g. space
  const r = new Reader(buffer, start);
  const numberOfContours = r.i16();
  r.i16(); r.i16(); r.i16(); r.i16(); // bounding box

  if (numberOfContours < 0) {
    // Composite: accented letters are built from parts. Offsets only; the scaling
    // variants are vanishingly rare in ASCII and would need a full affine.
    const contours = [];
    for (;;) {
      const flags = r.u16();
      const glyphIndex = r.u16();
      let dx = 0, dy = 0;
      if (flags & 1) { dx = r.i16(); dy = r.i16(); } else { dx = r.i8(); dy = r.i8(); }
      if (flags & 8) r.u16();
      else if (flags & 0x40) { r.u16(); r.u16(); }
      else if (flags & 0x80) { r.u16(); r.u16(); r.u16(); r.u16(); }
      for (const contour of readGlyph(buffer, glyf, loca, glyphIndex, depth + 1)) {
        contours.push(contour.map(([x, y, on]) => [x + dx, y + dy, on]));
      }
      if (!(flags & 0x20)) break;
    }
    return contours;
  }

  const endPts = [];
  for (let i = 0; i < numberOfContours; i++) endPts.push(r.u16());
  const instructionLength = r.u16();
  r.at += instructionLength;

  const total = endPts.length === 0 ? 0 : endPts[endPts.length - 1] + 1;
  const flags = [];
  while (flags.length < total) {
    const flag = r.u8();
    flags.push(flag);
    if (flag & 8) { let repeat = r.u8(); while (repeat-- > 0) flags.push(flag); }
  }

  const readCoords = (shortBit, sameBit) => {
    const out = [];
    let value = 0;
    for (const flag of flags) {
      if (flag & shortBit) {
        const delta = r.u8();
        value += (flag & sameBit) ? delta : -delta;
      } else if (!(flag & sameBit)) {
        value += r.i16();
      }
      out.push(value);
    }
    return out;
  };
  const xs = readCoords(2, 16);
  const ys = readCoords(4, 32);

  const contours = [];
  let from = 0;
  for (const end of endPts) {
    const contour = [];
    for (let i = from; i <= end; i++) contour.push([xs[i], ys[i], (flags[i] & 1) ? 1 : 0]);
    if (contour.length > 0) contours.push(contour);
    from = end + 1;
  }
  return contours;
}

// ---------------------------------------------------------------- extraction
mkdirSync(OUT, { recursive: true });
const faces = [];

for (const face of FACES) {
  const buffer = readFileSync(face.file);
  const t = tables(buffer);
  for (const required of ['head', 'maxp', 'cmap', 'loca', 'glyf', 'hmtx', 'hhea']) {
    if (!t[required]) throw new Error(`${face.file}: no ${required} table`);
  }

  const head = new Reader(buffer, t.head.offset);
  head.at += 18;
  const unitsPerEm = head.u16();
  head.at = t.head.offset + 50;
  const indexToLocFormat = head.i16();

  const maxp = new Reader(buffer, t.maxp.offset);
  maxp.u32();
  const numGlyphs = maxp.u16();

  const hhea = new Reader(buffer, t.hhea.offset);
  hhea.at = t.hhea.offset + 4;
  const ascender = hhea.i16();
  const descender = hhea.i16();
  hhea.at = t.hhea.offset + 34;
  const numberOfHMetrics = hhea.u16();

  const glyphFor = readCmap(buffer, t.cmap.offset);
  const loca = readLoca(buffer, t.loca.offset, numGlyphs, indexToLocFormat === 1);

  const advanceOf = (glyphIndex) => {
    const hmtx = new Reader(buffer, t.hmtx.offset);
    const i = Math.min(glyphIndex, numberOfHMetrics - 1);
    hmtx.at = t.hmtx.offset + i * 4;
    return hmtx.u16();
  };

  const glyphs = {};
  for (let code = 32; code <= 126; code++) {
    const glyphIndex = glyphFor(code);
    const contours = glyphIndex === 0 ? [] : readGlyph(buffer, t.glyf, loca, glyphIndex);
    glyphs[String.fromCharCode(code)] = {
      advance: advanceOf(glyphIndex),
      contours: contours.map((c) => c.flat()),
    };
  }
  faces.push({ ...face, unitsPerEm, ascender, descender, glyphs });
}

const header = `/**
 * GENERATED by tools/extract-fonts.mjs — do not edit.
 *
 * Printable-ASCII glyph outlines for the five faces the Text feature offers. Each
 * contour is a flat run of TrueType points, three numbers each: x, y, and 1 when the
 * point is ON the outline or 0 when it is a quadratic control point. Coordinates are in
 * font units; divide by unitsPerEm for ems.
 *
 * This build of OCCT has no font support, so text has to become geometry some other
 * way. Extracting the outlines once beats shipping font binaries and a TTF parser to
 * every user: a few tens of KB of integers, nothing loaded at runtime, and a document
 * layer that stays pure and testable in Node.
 *
 * Outline data derives from, and is redistributed under, these licences — see NOTICE.md:
${faces.map((f) => ` *   ${f.name.padEnd(10)} ${f.file}`).join('\n')}
 */

export interface GlyphData {
  readonly advance: number;
  readonly contours: readonly (readonly number[])[];
}

export interface FaceData {
  readonly name: string;
  readonly unitsPerEm: number;
  readonly ascender: number;
  readonly descender: number;
  readonly glyphs: Readonly<Record<string, GlyphData>>;
}

`;

const body = faces.map((f) => {
  const glyphs = Object.entries(f.glyphs)
    .map(([ch, g]) => `    ${JSON.stringify(ch)}: { advance: ${g.advance}, contours: [${g.contours.map((c) => `[${c.join(',')}]`).join(',')}] },`)
    .join('\n');
  return `const ${f.key}: FaceData = {\n  name: ${JSON.stringify(f.name)}, unitsPerEm: ${f.unitsPerEm}, ascender: ${f.ascender}, descender: ${f.descender},\n  glyphs: {\n${glyphs}\n  },\n};`;
}).join('\n\n');

const footer = `

/** The faces the Text feature offers, in the order they appear in the panel. */
export const FACES: Readonly<Record<string, FaceData>> = {
${faces.map((f) => `  ${f.key},`).join('\n')}
};
`;

const path = join(OUT, 'font-data.ts');
writeFileSync(path, header + body + footer);
console.log(`${path}  ${(readFileSync(path).length / 1024).toFixed(0)} KB`);
for (const f of faces) console.log(`  ${f.key.padEnd(10)} ${f.name.padEnd(10)} <- ${f.file}`);
