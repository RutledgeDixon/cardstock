import { describe, expect, it } from 'vitest';
import { Sketch } from './sketch.js';
import {
  APPLICABLE_CONSTRAINTS, applyConstraint, constraintFromSelection, constraintNeeds,
  type ApplicableConstraint,
} from './constrain.js';

/**
 * A selection either implies a constraint or it does not, and when it does not the user
 * needs to be told what to select instead.
 */
function square(): { sketch: Sketch; ids: Record<string, string> } {
  const sketch = new Sketch({ kind: 'origin', plane: 'xy' });
  sketch.addPoint(0, 0, { id: 'origin', fixed: true });
  const b = sketch.addPoint(20, 1);
  const c = sketch.addPoint(21, 20);
  const d = sketch.addPoint(1, 21);
  const bottom = sketch.addLine('origin', b);
  const right = sketch.addLine(b, c);
  const top = sketch.addLine(c, d);
  const left = sketch.addLine(d, 'origin');
  const centre = sketch.addPoint(10, 10);
  const circle = sketch.addCircle(centre, 4);
  const centre2 = sketch.addPoint(30, 10);
  const circle2 = sketch.addCircle(centre2, 6);
  return { sketch, ids: { b, c, d, bottom, right, top, left, centre, circle, centre2, circle2 } };
}

describe('constraints from a selection', () => {
  it('makes one line horizontal', () => {
    const { sketch, ids } = square();
    expect(applyConstraint(sketch, 'horizontal', [ids.bottom!])).toBeNull();
    expect(sketch.constraints.some((c) => c.type === 'horizontal')).toBe(true);
  });

  it('makes two lines parallel, and refuses one', () => {
    const { sketch, ids } = square();
    expect(applyConstraint(sketch, 'parallel', [ids.bottom!, ids.top!])).toBeNull();
    expect(applyConstraint(sketch, 'parallel', [ids.bottom!])).toBe('Select two lines');
  });

  it('fixes a point where it already is, not at the origin', () => {
    const { sketch, ids } = square();
    expect(applyConstraint(sketch, 'fix', [ids.b!])).toBeNull();
    const locks = sketch.constraints.filter((c) => c.type === 'lockX' || c.type === 'lockY');
    expect(locks).toHaveLength(2);
    // A fix must not MOVE anything: it pins the current position.
    expect(locks.map((c) => (c as { value: number }).value).sort((x, y) => x - y))
      .toEqual([1, 20]);
  });

  it('takes a line and a circle as tangent, but not two points', () => {
    const { sketch, ids } = square();
    expect(applyConstraint(sketch, 'tangent', [ids.bottom!, ids.circle!])).toBeNull();
    expect(applyConstraint(sketch, 'tangent', [ids.b!, ids.c!]))
      .toBe('Select a line and a circle, or two circles');
  });

  it('accepts equal for two lines or two circles, not one of each', () => {
    const { sketch, ids } = square();
    expect(applyConstraint(sketch, 'equal', [ids.bottom!, ids.top!])).toBeNull();
    expect(applyConstraint(sketch, 'equal', [ids.circle!, ids.circle2!])).toBeNull();
    expect(applyConstraint(sketch, 'equal', [ids.bottom!, ids.circle!]))
      .toBe('Select two lines, or two circles');
  });

  it('needs two points and a line to be symmetric', () => {
    const { sketch, ids } = square();
    expect(applyConstraint(sketch, 'symmetric', [ids.b!, ids.d!, ids.bottom!])).toBeNull();
    expect(applyConstraint(sketch, 'symmetric', [ids.b!, ids.d!]))
      .toBe('Select two points and a line');
  });

  it('gives every constraint a reason when the selection is empty', () => {
    // The reason is what a disabled button shows. One missing would be a dead end.
    const { sketch } = square();
    for (const type of APPLICABLE_CONSTRAINTS) {
      const result = constraintFromSelection(sketch, type as ApplicableConstraint, []);
      expect(result.ok, type).toBe(false);
      if (!result.ok) {
        expect(result.reason, type).toBe(constraintNeeds(type as ApplicableConstraint));
        expect(result.reason.length, type).toBeGreaterThan(0);
      }
    }
  });

  it('does not accept a line for coincident', () => {
    const { sketch, ids } = square();
    expect(applyConstraint(sketch, 'coincident', [ids.bottom!, ids.top!]))
      .toBe('Select two points');
    expect(applyConstraint(sketch, 'coincident', [ids.b!, ids.d!])).toBeNull();
  });
});
