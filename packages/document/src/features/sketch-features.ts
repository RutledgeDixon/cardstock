import type { FeatureDefinition } from './feature.js';
import { buildProfile, outerLoop } from '../sketch/profile.js';
import { resolvePlacement } from '../sketch/placement.js';
import { placementForFaceIndex } from '../sketch/face-plane.js';
import { resolveTopoRef } from '../toporef/resolver.js';

/**
 * Sketch-based features.
 *
 * The sketch feature turns a solved sketch into a face; extrude sweeps that face. Keeping
 * them separate means a profile can be reused, and it puts the "did this sketch close?"
 * error on the sketch rather than on whatever consumed it.
 */

export const sketchFeature: FeatureDefinition = {
  type: 'sketch',
  label: 'Sketch',
  shapeInputs: [],
  // The body a face-based sketch sits on. Optional, because an origin-plane sketch has
  // no body at all and declaring this as required would block every one of them.
  optionalShapeInputs: ['base'],
  valueKeys: [],
  async compute({ kernel, solver, sketch, parameters, shapes }) {
    if (!sketch) throw new Error('this sketch feature has no sketch');

    // A face plane is resolved fresh on every rebuild, through the same durable
    // reference machinery as any other topological selection, so the sketch follows its
    // face when the body underneath changes rather than staying where it was drawn.
    let placement = resolvePlacement(sketch.plane);
    if (!placement && sketch.plane.kind === 'face') {
      const base = shapes.base;
      if (!base) throw new Error('the body this sketch sits on is unavailable');
      const description = await kernel.describeShape(base);
      const resolved = resolveTopoRef(sketch.plane.ref, description);
      if (!resolved.ok) throw new Error(`the sketch plane ${resolved.reason}`);
      placement = placementForFaceIndex(description, resolved.index);
    }
    if (!placement) throw new Error('the sketch plane could not be resolved');

    const solved = await sketch.solve(solver, parameters);

    // A dimension whose expression cannot be evaluated is a user-visible mistake, and
    // saying which expression is wrong beats letting the sketch quietly solve without it.
    const broken = [...sketch.expressionErrors.entries()];
    if (broken.length > 0) {
      throw new Error(`dimension ${broken[0]![0]}: ${broken[0]![1]}`);
    }

    if (solved.status === 'failed' || solved.status === 'invalid') {
      throw new Error(
        solved.conflicting.length > 0
          ? `the sketch is over-constrained: ${solved.conflicting.join(', ')}`
          : (solved.message ?? 'the sketch could not be solved'),
      );
    }

    const { loops, openChains } = buildProfile(sketch.geometry);
    if (loops.length === 0) {
      // Say WHICH way it failed: an open chain and an ambiguous junction need different
      // fixes, and "no profile" tells the user neither.
      throw new Error(
        openChains[0]?.reason ?? 'the sketch contains no closed profile',
      );
    }

    // Largest loop is the boundary; the rest are holes.
    const outer = outerLoop(loops)!;
    const holes = loops.filter((loop) => loop !== outer);
    return kernel.makeFace({
      placement,
      loops: [outer, ...holes].map((loop) => ({
        segments: loop.segments, signedArea: loop.signedArea,
      })),
    });
  },
};

export const extrudeFeature: FeatureDefinition = {
  type: 'extrude',
  label: 'Extrude',
  shapeInputs: ['profile'],
  primaryInput: 'profile',
  valueKeys: ['distance', 'symmetric'],
  async compute({ kernel, shapes, values }) {
    const profile = shapes.profile;
    if (!profile) throw new Error('extrude needs a profile');
    const distance = values.distance ?? 10;
    if (distance === 0) throw new Error('extrude distance must not be zero');
    // A numeric flag rather than a boolean: feature values are all expressions, and one
    // uniform type keeps the hash, the panel and serialisation simple.
    return kernel.extrude(profile, distance, (values.symmetric ?? 0) !== 0);
  },
};
