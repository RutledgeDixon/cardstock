import { describe, expect, it } from 'vitest';
import { placeFan, placeSectors, type Bounds, type Point, type Size } from './layout.js';

const button: Size = { width: 104, height: 64 };
/** A small laptop window, with the sidebar's 92px taken off the right. */
const screen: Bounds = { left: 8, top: 8, right: 1280 - 8, bottom: 640 - 8 };
const leftOfSidebar: Bounds = { ...screen, right: 1280 - 92 - 8 };

const onScreen = (points: readonly Point[], b: Bounds) => points.every((p) =>
  p.x - button.width / 2 >= b.left - 1e-6 && p.x + button.width / 2 <= b.right + 1e-6
  && p.y - button.height / 2 >= b.top - 1e-6 && p.y + button.height / 2 <= b.bottom + 1e-6);

const overlapping = (points: readonly Point[]) => points.some((a, i) => points.some((b, j) =>
  i < j && Math.abs(a.x - b.x) < button.width && Math.abs(a.y - b.y) < button.height));

describe('right-click ring: fixed directions', () => {
  it('keeps every command in its own direction around the cursor', () => {
    const at = { x: 640, y: 320 };
    const { centre, positions } = placeSectors(at, [0, 2, 4, 6], 8, button, screen);
    expect(centre).toEqual(at);
    const [up, right, down, left] = positions;
    expect(up!.x).toBeCloseTo(at.x); expect(up!.y).toBeLessThan(at.y);
    expect(right!.y).toBeCloseTo(at.y); expect(right!.x).toBeGreaterThan(at.x);
    expect(down!.y).toBeGreaterThan(at.y);
    expect(left!.x).toBeLessThan(at.x);
    expect(overlapping(positions)).toBe(false);
  });

  it('slides the whole ring away from a corner instead of losing buttons off screen', () => {
    const all = [0, 1, 2, 3, 4, 5, 6, 7];
    const { centre, positions } = placeSectors({ x: 20, y: 15 }, all, 8, button, screen);
    expect(onScreen(positions, screen)).toBe(true);
    expect(centre.x).toBeGreaterThan(20);
    expect(centre.y).toBeGreaterThan(15);
    // Still a ring: sector 2 is due right of the (moved) centre.
    expect(positions[2]!.y).toBeCloseTo(centre.y);
    expect(positions[2]!.x).toBeGreaterThan(centre.x);
  });
});

describe('group fan', () => {
  it('rings a point in open space, starting straight up', () => {
    const at = { x: 640, y: 320 };
    const { centre, positions } = placeFan(at, 5, button, screen);
    expect(centre).toEqual(at);
    expect(positions[0]!.x).toBeCloseTo(at.x);
    expect(positions[0]!.y).toBeLessThan(at.y);
    expect(onScreen(positions, screen)).toBe(true);
    expect(overlapping(positions)).toBe(false);
  });

  it('opens beside a sidebar button, never under the sidebar, and stays close to it', () => {
    for (const y of [40, 200, 330, 590]) {
      const at = { x: 1280 - 46, y };
      const { positions } = placeFan(at, 7, button, leftOfSidebar);
      expect(onScreen(positions, leftOfSidebar)).toBe(true);
      expect(overlapping(positions)).toBe(false);
      // A ring centred exactly on an edge button grew past 400px before everything
      // fitted; the menu should read as coming from the button.
      const nearest = Math.min(...positions.map((p) => Math.hypot(p.x - at.x, p.y - at.y)));
      expect(nearest).toBeLessThan(220);
    }
  });

  it('reads top to bottom when it has to be an arc', () => {
    // Pinned to the left edge with no room to move in: a half ring, read downward.
    const narrow: Bounds = { left: 8, top: 8, right: 400, bottom: 632 };
    const { positions } = placeFan({ x: 8, y: 320 }, 4, button, narrow);
    expect(onScreen(positions, narrow)).toBe(true);
    const ys = positions.map((p) => p.y);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
  });

  it('still fits from the bottom of the sidebar, in a short window', () => {
    // The File button sits at the foot of the strip.
    const at = { x: 1280 - 46, y: 600 };
    const { positions } = placeFan(at, 6, button, leftOfSidebar);
    expect(onScreen(positions, leftOfSidebar)).toBe(true);
    expect(overlapping(positions)).toBe(false);
  });

  it('places even fifteen buttons on screen', () => {
    // The sketch constraint list at its longest.
    const { positions } = placeFan({ x: 300, y: 300 }, 15, button, screen);
    expect(positions).toHaveLength(15);
    expect(onScreen(positions, screen)).toBe(true);
    expect(overlapping(positions)).toBe(false);
  });
});
