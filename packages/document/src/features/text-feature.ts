import type { PlanePlacement, Vec3 } from '@cardstock/types';
import type { FeatureDefinition } from './feature.js';
import { TEXT_FONTS, textLayout } from './text-outline.js';

/**
 * Which way the text reads on a face.
 *
 * A sketch plane's in-plane X is chosen for STABILITY — any deterministic function of
 * the normal will do, because what matters is that a rebuild does not rotate everything
 * drawn on it. Text cannot use that: on a top face it comes out running along −Y, so a
 * label reads sideways off the edge of the part. Reading direction is world +X laid into
 * the face, or +Y when the face points along X and +X has nowhere to go — which gives
 * upright text on all six faces of a box, and still depends on nothing but the normal.
 */
function readingPlacement(origin: Vec3, direction: Vec3, angleDegrees: number): PlanePlacement | null {
  const normal = normalise(direction);
  if (!normal) return null;
  const along = Math.abs(normal.x) > 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const flat = normalise(subtract(along, scale(normal, dot(along, normal))));
  if (!flat) return null;

  // Turn it about the face's own normal, so a label can be laid at any angle.
  const radians = (angleDegrees * Math.PI) / 180;
  const up = cross(normal, flat);
  const xAxis = normalise(add(scale(flat, Math.cos(radians)), scale(up, Math.sin(radians))));
  if (!xAxis) return null;
  return { origin, normal, xAxis };
}

const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const subtract = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const scale = (v: Vec3, k: number): Vec3 => ({ x: v.x * k, y: v.y * k, z: v.z * k });
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x,
});
function normalise(v: Vec3): Vec3 | null {
  const length = Math.hypot(v.x, v.y, v.z);
  return length < 1e-9 ? null : { x: v.x / length, y: v.y / length, z: v.z / length };
}

/**
 * Text on a face, raised or sunk.
 *
 * The sign of the depth decides which: positive stands the letters proud of the surface
 * and fuses them on, negative cuts them into it. One value rather than a mode, because
 * "how deep" and "which way" are the same question about a label, and a separate toggle
 * would be a second thing to get wrong.
 *
 * No new kernel operation is needed. Glyph outlines become profile loops, the same
 * closed loops a sketch produces, so the existing makeFace → extrude → boolean path
 * does all of the geometry — and a letter's counter is a hole for the same reason a
 * sketched circle inside a rectangle is.
 */
export const textFeature: FeatureDefinition = {
  type: 'text',
  label: 'Text',
  shapeInputs: ['base'],
  primaryInput: 'base',
  valueKeys: ['size', 'depth', 'angle'],
  choiceKeys: { font: TEXT_FONTS as readonly string[] },
  textKeys: ['text'],
  async compute({ kernel, shapes, values, selections, feature }) {
    const base = shapes.base;
    if (!base) throw new Error('text needs a body to sit on');

    const faces = selections.faces ?? [];
    if (faces.length === 0) throw new Error('text needs a face to sit on — select one');

    const description = await kernel.describeShape(base);
    const on = description.faces.find((f) => f.index === faces[0]!);
    if (!on?.direction) throw new Error('text needs a flat face; that one is curved');
    const placement = readingPlacement(on.centroid, on.direction, values.angle ?? 0);
    if (!placement) throw new Error('text needs a flat face; that one is curved');

    const text = feature.values.text ?? '';
    if (text.trim() === '') throw new Error('type something for the text to say');

    const size = values.size ?? 6;
    if (size <= 0) throw new Error('text size must be positive');
    const depth = values.depth ?? 1;
    if (depth === 0) throw new Error('text depth must not be zero — its sign raises or sinks the letters');

    const font = feature.values.font ?? TEXT_FONTS[0]!;
    const { regions } = textLayout(text, font, size);
    if (regions.length === 0) throw new Error('that text has nothing to draw');

    const [first, ...rest] = regions;
    const face = await kernel.makeFace({
      placement, loops: first!, ...(rest.length > 0 ? { regions: rest } : {}),
    });

    // Sunk letters are extruded INTO the body and cut away; raised ones stand out and
    // are fused on. Either way the letters start at the surface, so the depth is what
    // the caliper would read.
    const solid = await kernel.extrude(face.handle, depth);
    return kernel.boolean(depth > 0 ? 'union' : 'cut', base, solid.handle);
  },
};
