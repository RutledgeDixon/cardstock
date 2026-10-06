import { describe, expect, it } from 'vitest';
import { RING, placeArc, placeRing, sliceBox, sliceMiddle, type Bounds, type Slice } from './layout.js';

/** A small laptop window, with the 92px sidebar taken off the right. */
const screen: Bounds = { left: 8, top: 8, right: 1272, bottom: 632 };
const leftOfSidebar: Bounds = { ...screen, right: 1280 - 92 - 8 };
const sidebarButton = (y: number) => ({ x: 1280 - 46, y });

const onScreen = (slices: readonly Slice[], b: Bounds) => slices.every((s) => {
  const box = sliceBox(s);
  return box.left >= b.left - 1e-6 && box.right <= b.right + 1e-6
    && box.top >= b.top - 1e-6 && box.bottom <= b.bottom + 1e-6;
});

describe('right-click ring', () => {
  it('is the band it always was, each command in its own direction', () => {
    const at = { x: 640, y: 320 };
    const { centre, slices } = placeRing(at, [0, 2, 4, 6], 8, screen);
    expect(centre).toEqual(at);
    expect(slices.every((s) => s.inner === RING.inner && s.outer === RING.outer)).toBe(true);
    const [up, right, down, left] = slices.map(sliceMiddle);
    expect(up!.x).toBeCloseTo(at.x); expect(up!.y).toBeLessThan(at.y);
    expect(right!.y).toBeCloseTo(at.y); expect(right!.x).toBeGreaterThan(at.x);
    expect(down!.y).toBeGreaterThan(at.y);
    expect(left!.x).toBeLessThan(at.x);
  });

  it('slides away from a corner rather than losing slices off screen', () => {
    const { centre, slices } = placeRing({ x: 20, y: 15 }, [0, 1, 2, 3, 4, 5, 6, 7], 8, screen);
    expect(onScreen(slices, screen)).toBe(true);
    expect(centre.x).toBeGreaterThan(20);
    expect(centre.y).toBeGreaterThan(15);
  });
});

describe('sidebar arc', () => {
  it('runs the list down the sidebar, gently curved, top to bottom, a little apart', () => {
    const at = sidebarButton(300);
    const slices = placeArc(at, 7, leftOfSidebar);
    expect(slices).toHaveLength(7);
    expect(onScreen(slices, leftOfSidebar)).toBe(true);
    const mids = slices.map(sliceMiddle);
    expect(mids.map((m) => m.y)).toEqual(mids.map((m) => m.y).sort((a, b) => a - b));
    // Separated: each slice ends before the next begins.
    for (let i = 1; i < slices.length; i++) expect(slices[i]!.to).toBeLessThan(slices[i - 1]!.from);
    // Centred on the button and hugging the strip: the arc bends round the button, so
    // its end rows meet the sidebar's edge and the middle stands off only a little — a
    // list, curved.
    expect(mids[3]!.y).toBeCloseTo(at.y, 0);
    const boxes = slices.map(sliceBox);
    const gaps = boxes.map((b) => leftOfSidebar.right - b.right);
    expect(Math.min(...gaps)).toBeLessThan(4);
    expect(gaps[3]).toBeLessThan(40);
    const bow = Math.max(...mids.map((m) => m.x)) - Math.min(...mids.map((m) => m.x));
    expect(bow).toBeGreaterThan(5);
    expect(bow).toBeLessThan(60);
    // Rows lean only slightly: no row turns more than 25 degrees from level.
    for (const sl of slices) {
      expect(Math.abs((sl.from + sl.to) / 2 - Math.PI * 1.5)).toBeLessThan((25 * Math.PI) / 180);
    }
  });

  it('slides down from the top button and up from the bottom one, staying on screen', () => {
    for (const y of [40, 600]) {
      const at = sidebarButton(y);
      const slices = placeArc(at, 6, leftOfSidebar);
      expect(onScreen(slices, leftOfSidebar)).toBe(true);
      // Still beside the button: the nearest row is within a couple of rows of it.
      const nearest = Math.min(...slices.map((s) => Math.abs(sliceMiddle(s).y - at.y)));
      expect(nearest).toBeLessThan(80);
    }
  });

  it('falls back to a ring when the window is too short for the list', () => {
    const tiny: Bounds = { left: 8, top: 8, right: 900, bottom: 200 };
    const slices = placeArc({ x: 946, y: 100 }, 7, tiny);
    expect(slices).toHaveLength(7);
  });
});
