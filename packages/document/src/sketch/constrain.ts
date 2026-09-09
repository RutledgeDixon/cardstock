import type { NewSketchConstraint, SketchConstraintType, SketchGeometry } from '@cardstock/types';
import type { Sketch } from './sketch.js';

/**
 * Turning a selection into a constraint.
 *
 * Every constraint needs particular things selected — two lines, a point and a circle —
 * and getting it wrong is the normal case while learning. So this lives here, headless
 * and tested, and it answers with a REASON when it cannot, which the UI shows on the
 * disabled button. "Perpendicular" greyed out with no explanation teaches nothing.
 */

export type ConstrainResult =
  | { readonly ok: true; readonly constraints: readonly NewSketchConstraint[] }
  | { readonly ok: false; readonly reason: string };

/** Constraints a user can apply to a selection, in the order they belong in a menu. */
export const APPLICABLE_CONSTRAINTS = [
  'coincident', 'horizontal', 'vertical', 'parallel', 'perpendicular',
  'tangent', 'equal', 'concentric', 'pointOnLine', 'symmetric', 'fix',
] as const;

export type ApplicableConstraint = (typeof APPLICABLE_CONSTRAINTS)[number];

const LABELS: Record<ApplicableConstraint, string> = {
  coincident: 'Coincident',
  horizontal: 'Horizontal',
  vertical: 'Vertical',
  parallel: 'Parallel',
  perpendicular: 'Perpendicular',
  tangent: 'Tangent',
  equal: 'Equal',
  concentric: 'Concentric',
  pointOnLine: 'Point on line',
  symmetric: 'Symmetric',
  fix: 'Fix in place',
};

/** What each one needs, phrased as the instruction to follow. */
const NEEDS: Record<ApplicableConstraint, string> = {
  coincident: 'Select two points',
  horizontal: 'Select a line, or two points',
  vertical: 'Select a line, or two points',
  parallel: 'Select two lines',
  perpendicular: 'Select two lines',
  tangent: 'Select a line and a circle, or two circles',
  equal: 'Select two lines, or two circles',
  concentric: 'Select two circles',
  pointOnLine: 'Select a point and a line',
  symmetric: 'Select two points and a line',
  fix: 'Select a point',
};

export const constraintLabel = (type: ApplicableConstraint): string => LABELS[type];
export const constraintNeeds = (type: ApplicableConstraint): string => NEEDS[type];

const isRound = (e: SketchGeometry): boolean => e.type === 'circle' || e.type === 'arc';

/**
 * Build the constraint(s) a selection implies, or say why it cannot.
 *
 * `fix` produces TWO constraints — pinning a point is lockX and lockY together — which is
 * why the result is a list rather than a single constraint.
 */
export function constraintFromSelection(
  sketch: Sketch,
  type: ApplicableConstraint,
  selection: Iterable<string>,
): ConstrainResult {
  const entities = [...selection]
    .map((id) => sketch.entity(id))
    .filter((e): e is SketchGeometry => e !== undefined);

  const no = (): ConstrainResult => ({ ok: false, reason: NEEDS[type] });
  const points = entities.filter((e) => e.type === 'point');
  const lines = entities.filter((e) => e.type === 'line');
  const round = entities.filter(isRound);

  const one = (c: NewSketchConstraint): ConstrainResult => ({ ok: true, constraints: [c] });

  switch (type) {
    case 'coincident':
      if (points.length !== 2) return no();
      return one({ type: 'coincident', a: points[0]!.id, b: points[1]!.id });

    case 'horizontal':
    case 'vertical': {
      if (lines.length === 1 && entities.length === 1) {
        return one({ type, line: lines[0]!.id });
      }
      // Two points with nothing to join them still has a meaning: put them level. The
      // solver expresses that as a construction-free line only if one exists, so this
      // asks for the line instead of inventing geometry the user did not draw.
      return no();
    }

    case 'parallel':
    case 'perpendicular':
      if (lines.length !== 2) return no();
      return one({ type, a: lines[0]!.id, b: lines[1]!.id });

    case 'tangent':
      if (entities.length !== 2) return no();
      if (round.length === 0) return no();
      return one({ type, a: entities[0]!.id, b: entities[1]!.id });

    case 'equal':
      if (lines.length === 2) return one({ type, a: lines[0]!.id, b: lines[1]!.id });
      if (round.length === 2) return one({ type, a: round[0]!.id, b: round[1]!.id });
      return no();

    case 'concentric':
      if (round.length !== 2) return no();
      return one({ type, a: round[0]!.id, b: round[1]!.id });

    case 'pointOnLine':
      if (points.length !== 1 || lines.length !== 1) return no();
      return one({ type, point: points[0]!.id, line: lines[0]!.id });

    case 'symmetric':
      if (points.length !== 2 || lines.length !== 1) return no();
      return one({
        type, a: points[0]!.id, b: points[1]!.id, line: lines[0]!.id,
      });

    case 'fix': {
      if (points.length !== 1 || entities.length !== 1) return no();
      const point = points[0]!;
      if (point.type !== 'point') return no();
      // Pinned where it already is: a fix should not move anything, only stop it moving.
      return {
        ok: true,
        constraints: [
          { type: 'lockX', point: point.id, value: point.x },
          { type: 'lockY', point: point.id, value: point.y },
        ],
      };
    }
  }
}

/** Apply a constraint to a selection. @returns the reason it could not, or null. */
export function applyConstraint(
  sketch: Sketch,
  type: ApplicableConstraint,
  selection: Iterable<string>,
): string | null {
  const result = constraintFromSelection(sketch, type, selection);
  if (!result.ok) return result.reason;
  for (const constraint of result.constraints) sketch.addConstraint(constraint);
  return null;
}

export type { SketchConstraintType };
