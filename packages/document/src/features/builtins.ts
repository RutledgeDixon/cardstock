import type { Vec3 } from '@cardstock/types';
import { type FeatureDefinition, FeatureRegistry } from './feature.js';
import { extrudeFeature, sketchFeature } from './sketch-features.js';
import { PHASE7_FEATURES } from './solid-features.js';
import { importFeature } from './import-feature.js';

/**
 * The Phase 2 feature set: enough shapes and operations to exercise the recompute graph
 * end to end. Phase 7 adds the real catalogue (sweeps, shells, patterns, holes).
 */

const origin = (v: Record<string, number>, prefix = ''): Vec3 => ({
  x: v[`${prefix}x`] ?? 0,
  y: v[`${prefix}y`] ?? 0,
  z: v[`${prefix}z`] ?? 0,
});

export const boxFeature: FeatureDefinition = {
  type: 'box',
  label: 'Box',
  shapeInputs: [],
  valueKeys: ['dx', 'dy', 'dz', 'x', 'y', 'z'],
  compute: ({ kernel, values }) =>
    kernel.makeBox({
      dx: values.dx ?? 1,
      dy: values.dy ?? 1,
      dz: values.dz ?? 1,
      origin: origin(values),
    }),
};

export const cylinderFeature: FeatureDefinition = {
  type: 'cylinder',
  label: 'Cylinder',
  shapeInputs: [],
  valueKeys: ['radius', 'height', 'x', 'y', 'z'],
  compute: ({ kernel, values }) =>
    kernel.makeCylinder({
      radius: values.radius ?? 1,
      height: values.height ?? 1,
      origin: origin(values),
    }),
};

export const sphereFeature: FeatureDefinition = {
  type: 'sphere',
  label: 'Sphere',
  shapeInputs: [],
  valueKeys: ['radius', 'x', 'y', 'z'],
  compute: ({ kernel, values }) =>
    kernel.makeSphere({ radius: values.radius ?? 1, origin: origin(values) }),
};

/** Union / cut / intersect. The op is part of the feature's values, not its type, so a
 *  user can flip a cut to a union without deleting and re-creating the feature. */
function booleanFeature(type: string, op: 'union' | 'cut' | 'intersect'): FeatureDefinition {
  return {
    type,
    label: op === 'cut' ? 'Cut' : op === 'union' ? 'Union' : 'Intersect',
    shapeInputs: ['base', 'tool'],
    primaryInput: 'base',
    valueKeys: [],
    compute: ({ kernel, shapes }) => {
      const base = shapes.base;
      const tool = shapes.tool;
      if (!base || !tool) throw new Error('boolean needs both a base and a tool shape');
      return kernel.boolean(op, base, tool);
    },
  };
}

export const unionFeature = booleanFeature('union', 'union');
export const cutFeature = booleanFeature('cut', 'cut');
export const intersectFeature = booleanFeature('intersect', 'intersect');

export const filletFeature: FeatureDefinition = {
  type: 'fillet',
  label: 'Fillet',
  shapeInputs: ['base'],
  primaryInput: 'base',
  valueKeys: ['radius'],
  compute: ({ kernel, shapes, values, selections }) => {
    const base = shapes.base;
    if (!base) throw new Error('fillet needs a base shape');
    const edges = selections.edges ?? [];
    if (edges.length === 0) throw new Error('fillet has no edges selected');
    return kernel.fillet(base, edges, values.radius ?? 1);
  },
};

export const chamferFeature: FeatureDefinition = {
  type: 'chamfer',
  label: 'Chamfer',
  shapeInputs: ['base'],
  primaryInput: 'base',
  valueKeys: ['distance'],
  compute: ({ kernel, shapes, values, selections }) => {
    const base = shapes.base;
    if (!base) throw new Error('chamfer needs a base shape');
    const edges = selections.edges ?? [];
    if (edges.length === 0) throw new Error('chamfer has no edges selected');
    return kernel.chamfer(base, edges, values.distance ?? 1);
  },
};

export const moveFeature: FeatureDefinition = {
  type: 'move',
  label: 'Move',
  shapeInputs: ['base'],
  primaryInput: 'base',
  valueKeys: ['dx', 'dy', 'dz'],
  compute: ({ kernel, shapes, values }) => {
    const base = shapes.base;
    if (!base) throw new Error('move needs a base shape');
    // Column-major 4x4 translation.
    return kernel.transform(base, [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      values.dx ?? 0, values.dy ?? 0, values.dz ?? 0, 1,
    ]);
  },
};

export const BUILTIN_FEATURES: readonly FeatureDefinition[] = [
  boxFeature, cylinderFeature, sphereFeature,
  sketchFeature, extrudeFeature,
  ...PHASE7_FEATURES,
  unionFeature, cutFeature, intersectFeature,
  filletFeature, chamferFeature, moveFeature,
  importFeature,
];

export function createBuiltinRegistry(): FeatureRegistry {
  const registry = new FeatureRegistry();
  for (const def of BUILTIN_FEATURES) registry.register(def);
  return registry;
}
