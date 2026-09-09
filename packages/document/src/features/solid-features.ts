import type { GeometryResult, ShapeHandle, Vec3 } from '@cardstock/types';
import type { ComputeContext, FeatureDefinition } from './feature.js';
import { fastenerNames, findFastener, holeDiameter, type HoleFit } from './fasteners.js';

/**
 * The Phase 7 feature set: revolve, shell, mirror, patterns and holes.
 */

const axisFrom = (values: Readonly<Record<string, number>>): Vec3 => {
  const axis = { x: values.axisX ?? 0, y: values.axisY ?? 0, z: values.axisZ ?? 1 };
  const length = Math.hypot(axis.x, axis.y, axis.z);
  // A zero axis has no direction to sweep around; default to Z rather than fail
  // obscurely inside the kernel.
  return length < 1e-9 ? { x: 0, y: 0, z: 1 } : axis;
};

export const revolveFeature: FeatureDefinition = {
  type: 'revolve',
  label: 'Revolve',
  shapeInputs: ['profile'],
  primaryInput: 'profile',
  valueKeys: ['angle', 'x', 'y', 'z', 'axisX', 'axisY', 'axisZ'],
  async compute({ kernel, shapes, values }) {
    const profile = shapes.profile;
    if (!profile) throw new Error('revolve needs a profile');
    return kernel.revolve(
      profile,
      {
        origin: { x: values.x ?? 0, y: values.y ?? 0, z: values.z ?? 0 },
        direction: axisFrom(values),
      },
      values.angle ?? 360,
    );
  },
};

export const shellFeature: FeatureDefinition = {
  type: 'shell',
  label: 'Shell',
  shapeInputs: ['base'],
  primaryInput: 'base',
  valueKeys: ['thickness'],
  async compute({ kernel, shapes, values, selections }) {
    const base = shapes.base;
    if (!base) throw new Error('shell needs a solid');
    const faces = selections.faces ?? [];
    if (faces.length === 0) throw new Error('shell has no open faces selected');
    const thickness = values.thickness ?? 2;
    // Negative offsets inward, which is what "wall thickness" means for a printed part.
    return kernel.shell(base, faces, -Math.abs(thickness));
  },
};

export const mirrorFeature: FeatureDefinition = {
  type: 'mirror',
  label: 'Mirror',
  shapeInputs: ['base'],
  primaryInput: 'base',
  valueKeys: ['x', 'y', 'z', 'normalX', 'normalY', 'normalZ', 'keepOriginal'],
  async compute({ kernel, shapes, values }) {
    const base = shapes.base;
    if (!base) throw new Error('mirror needs a solid');
    const normal = {
      x: values.normalX ?? 1, y: values.normalY ?? 0, z: values.normalZ ?? 0,
    };
    if (Math.hypot(normal.x, normal.y, normal.z) < 1e-9) {
      throw new Error('the mirror plane needs a direction');
    }
    const plane = {
      origin: { x: values.x ?? 0, y: values.y ?? 0, z: values.z ?? 0 },
      normal,
    };
    const reflected = await kernel.mirror(base, plane);
    // Keeping the original is the usual intent: mirroring is how you make a symmetric
    // part, not how you move one to the other side.
    if ((values.keepOriginal ?? 1) === 0) return reflected;
    return kernel.boolean('union', base, reflected.handle);
  },
};

/** Union a run of transformed copies onto the original. */
async function repeat(
  ctx: ComputeContext,
  base: ShapeHandle,
  count: number,
  offsetFor: (index: number) => readonly number[],
): Promise<GeometryResult> {
  if (!Number.isFinite(count) || count < 2) {
    throw new Error('a pattern needs a count of at least 2');
  }
  if (count > 200) {
    // Each copy is a transform plus a boolean; a runaway count would hang the worker
    // rather than fail, which is far worse than refusing.
    throw new Error(`a pattern of ${Math.round(count)} is too many (limit 200)`);
  }

  let result: GeometryResult = { handle: base };
  for (let index = 1; index < Math.round(count); index++) {
    const copy = await ctx.kernel.transform(base, offsetFor(index));
    result = await ctx.kernel.boolean('union', result.handle, copy.handle);
  }
  return result;
}

/** Column-major translation. */
const translation = (x: number, y: number, z: number): number[] =>
  [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];

/** Column-major rotation about an axis through the origin. */
function rotation(axis: Vec3, radians: number, centre: Vec3): number[] {
  const length = Math.hypot(axis.x, axis.y, axis.z) || 1;
  const [x, y, z] = [axis.x / length, axis.y / length, axis.z / length];
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  const t = 1 - c;

  const m = [
    t * x * x + c,     t * x * y + s * z, t * x * z - s * y,
    t * x * y - s * z, t * y * y + c,     t * y * z + s * x,
    t * x * z + s * y, t * y * z - s * x, t * z * z + c,
  ];
  // Rotate about `centre`, not the world origin: a circular pattern is meaningless
  // otherwise.
  const tx = centre.x - (m[0]! * centre.x + m[3]! * centre.y + m[6]! * centre.z);
  const ty = centre.y - (m[1]! * centre.x + m[4]! * centre.y + m[7]! * centre.z);
  const tz = centre.z - (m[2]! * centre.x + m[5]! * centre.y + m[8]! * centre.z);

  return [
    m[0]!, m[1]!, m[2]!, 0,
    m[3]!, m[4]!, m[5]!, 0,
    m[6]!, m[7]!, m[8]!, 0,
    tx, ty, tz, 1,
  ];
}

export const linearPatternFeature: FeatureDefinition = {
  type: 'linearPattern',
  label: 'Linear pattern',
  shapeInputs: ['base'],
  primaryInput: 'base',
  valueKeys: ['count', 'spacing', 'dx', 'dy', 'dz'],
  async compute(ctx) {
    const base = ctx.shapes.base;
    if (!base) throw new Error('a pattern needs something to repeat');
    const { values } = ctx;
    const spacing = values.spacing ?? 10;
    const direction = { x: values.dx ?? 1, y: values.dy ?? 0, z: values.dz ?? 0 };
    const length = Math.hypot(direction.x, direction.y, direction.z);
    if (length < 1e-9) throw new Error('a linear pattern needs a direction');

    const step = {
      x: (direction.x / length) * spacing,
      y: (direction.y / length) * spacing,
      z: (direction.z / length) * spacing,
    };
    return repeat(ctx, base, values.count ?? 2,
      (index) => translation(step.x * index, step.y * index, step.z * index));
  },
};

export const circularPatternFeature: FeatureDefinition = {
  type: 'circularPattern',
  label: 'Circular pattern',
  shapeInputs: ['base'],
  primaryInput: 'base',
  valueKeys: ['count', 'angle', 'x', 'y', 'z', 'axisX', 'axisY', 'axisZ'],
  async compute(ctx) {
    const base = ctx.shapes.base;
    if (!base) throw new Error('a pattern needs something to repeat');
    const { values } = ctx;
    const count = Math.round(values.count ?? 4);
    const total = values.angle ?? 360;
    const centre = { x: values.x ?? 0, y: values.y ?? 0, z: values.z ?? 0 };
    const axis = axisFrom(values);

    // A full turn divides by count; a partial arc spans its ends inclusively, which is
    // what "6 holes over 90 degrees" is understood to mean.
    const stepDegrees = Math.abs(total) >= 360 ? total / count : total / (count - 1 || 1);
    return repeat(ctx, base, count,
      (index) => rotation(axis, (stepDegrees * index * Math.PI) / 180, centre));
  },
};

export const holeFeature: FeatureDefinition = {
  type: 'hole',
  label: 'Hole',
  shapeInputs: ['base'],
  primaryInput: 'base',
  valueKeys: ['x', 'y', 'z', 'depth', 'diameter', 'compensation', 'counterboreDepth'],
  choiceKeys: {
    standard: fastenerNames(),
    fit: ['tap', 'close', 'normal', 'loose'],
    style: ['simple', 'counterbore'],
  },
  async compute({ kernel, shapes, values, feature }) {
    const base = shapes.base;
    if (!base) throw new Error('a hole needs something to cut into');

    const standard = feature.values.standard ?? '';
    const fit = (feature.values.fit ?? 'normal') as HoleFit;
    const style = feature.values.style ?? 'simple';

    // An explicit diameter always wins: the table is a convenience, not a cage.
    let diameter = values.diameter ?? 0;
    let fastener = findFastener(standard);
    if (diameter <= 0) {
      if (!fastener) {
        throw new Error(
          standard
            ? `"${standard}" is not a fastener size in the table`
            : 'give the hole a diameter, or a fastener size',
        );
      }
      diameter = holeDiameter(fastener, fit);
    }

    // FDM pulls holes undersize; the compensation is an offset the user controls.
    diameter += values.compensation ?? 0;
    if (diameter <= 0) throw new Error('the hole diameter must be positive');

    const depth = values.depth ?? 20;
    if (depth <= 0) throw new Error('the hole depth must be positive');

    const origin = { x: values.x ?? 0, y: values.y ?? 0, z: values.z ?? 0 };
    // Start just above the surface so the cut breaks cleanly through it rather than
    // leaving a zero-thickness sliver OCCT has to resolve.
    const overshoot = 0.01;
    const drill = await kernel.makeCylinder({
      radius: diameter / 2,
      height: depth + overshoot * 2,
      origin: { ...origin, z: origin.z - depth + -overshoot },
    });

    let cut = await kernel.boolean('cut', base, drill.handle);

    if (style === 'counterbore') {
      fastener ??= findFastener(standard);
      if (!fastener) throw new Error('a counterbore needs a fastener size');
      const boreDepth = values.counterboreDepth ?? fastener.headHeight;
      const bore = await kernel.makeCylinder({
        radius: fastener.headDiameter / 2 + (values.compensation ?? 0) / 2,
        height: boreDepth + overshoot,
        origin: { ...origin, z: origin.z - boreDepth },
      });
      cut = await kernel.boolean('cut', cut.handle, bore.handle);
    }

    return cut;
  },
};

export const PHASE7_FEATURES: readonly FeatureDefinition[] = [
  revolveFeature, shellFeature, mirrorFeature,
  linearPatternFeature, circularPatternFeature, holeFeature,
];
