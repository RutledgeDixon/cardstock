import { describe, expect, it } from 'vitest';
import type { SketchGeometry } from '@cardstock/types';
import { inferAxisAlignment, inferForNewLine, snapToAxis, snapToPoint } from './inference.js';

const point = (id: string, x: number, y: number): SketchGeometry => ({ id, type: 'point', x, y });
const line = (id: string, p1: string, p2: string): SketchGeometry => ({ id, type: 'line', p1, p2 });

describe('snapping to an existing point', () => {
  const geometry = [point('a', 0, 0), point('b', 10, 0), point('c', 10.5, 0.5)];

  it('finds a point within the snap radius', () => {
    expect(snapToPoint(geometry, { x: 0.4, y: -0.3 })).toBe('a');
  });

  it('picks the CLOSEST when several are in range', () => {
    // Taking whichever was created first is arbitrary and feels broken.
    expect(snapToPoint(geometry, { x: 10.4, y: 0.4 })).toBe('c');
  });

  it('ignores points that are too far', () => {
    expect(snapToPoint(geometry, { x: 40, y: 40 })).toBeNull();
  });

  it('honours the exclusion list, so a point cannot snap to itself', () => {
    expect(snapToPoint(geometry, { x: 0, y: 0 }, ['a'])).toBeNull();
  });

  it('ignores non-point geometry', () => {
    expect(snapToPoint([line('l', 'a', 'b')], { x: 0, y: 0 })).toBeNull();
  });
});

describe('axis alignment', () => {
  const withLine = (x2: number, y2: number) =>
    [point('a', 0, 0), point('b', x2, y2), line('l', 'a', 'b')];

  it('infers horizontal for a line drawn nearly flat', () => {
    expect(inferAxisAlignment(withLine(50, 1), 'l')).toMatchObject({
      label: 'Horizontal', constraint: { type: 'horizontal', line: 'l' },
    });
  });

  it('infers vertical for a line drawn nearly upright', () => {
    expect(inferAxisAlignment(withLine(1, 50), 'l')).toMatchObject({ label: 'Vertical' });
  });

  it('infers nothing for a deliberate diagonal', () => {
    // Guessing here would silently change what the user drew.
    expect(inferAxisAlignment(withLine(50, 30), 'l')).toBeNull();
  });

  it('works for lines drawn right-to-left', () => {
    expect(inferAxisAlignment(withLine(-50, 1), 'l')).toMatchObject({ label: 'Horizontal' });
  });

  it('infers nothing from a zero-length line', () => {
    // Its angle is noise, not intent.
    expect(inferAxisAlignment(withLine(0, 0), 'l')).toBeNull();
  });

  it('respects a tighter tolerance', () => {
    const nearlyFlat = withLine(50, 2.6); // about 3 degrees
    expect(inferAxisAlignment(nearlyFlat, 'l')).not.toBeNull();
    expect(inferAxisAlignment(nearlyFlat, 'l', { snapDistance: 3, angleTolerance: 1 })).toBeNull();
  });
});

describe('inference for a newly drawn line', () => {
  const geometry = [point('a', 0, 0), point('b', 50, 1), line('l', 'a', 'b')];

  it('suggests one alignment', () => {
    expect(inferForNewLine(geometry, 'l')).toHaveLength(1);
  });

  it('suggests nothing when the line is already aligned', () => {
    // Adding a second horizontal constraint would over-constrain the sketch the moment
    // it was drawn.
    const existing = [{ id: 'k1', type: 'horizontal' as const, line: 'l' }];
    expect(inferForNewLine(geometry, 'l', existing)).toEqual([]);
  });
});

describe('drawing feedback', () => {
  it('snaps a near-horizontal drag onto the axis', () => {
    const { position, axis } = snapToAxis({ x: 0, y: 0 }, { x: 40, y: 1 });
    expect(axis).toBe('horizontal');
    expect(position).toEqual({ x: 40, y: 0 });
  });

  it('snaps a near-vertical drag onto the axis', () => {
    const { position, axis } = snapToAxis({ x: 5, y: 5 }, { x: 6, y: 45 });
    expect(axis).toBe('vertical');
    expect(position).toEqual({ x: 5, y: 45 });
  });

  it('leaves a diagonal alone', () => {
    const { position, axis } = snapToAxis({ x: 0, y: 0 }, { x: 30, y: 30 });
    expect(axis).toBeNull();
    expect(position).toEqual({ x: 30, y: 30 });
  });

  it('does nothing at zero distance', () => {
    expect(snapToAxis({ x: 2, y: 2 }, { x: 2, y: 2 }).axis).toBeNull();
  });
});
