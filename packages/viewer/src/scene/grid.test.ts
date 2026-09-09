import { describe, expect, it } from 'vitest';
import { chooseGridSpacing } from './grid.js';

describe('chooseGridSpacing', () => {
  it('snaps to a 1/2/5 sequence so gridline values stay human', () => {
    for (const mmPerPixel of [0.001, 0.01, 0.05, 0.2, 1, 5, 40]) {
      const s = chooseGridSpacing(mmPerPixel);
      const mantissa = s / 10 ** Math.floor(Math.log10(s));
      expect([1, 2, 5, 10]).toContain(Math.round(mantissa));
    }
  });

  it('keeps gridlines in a legible pixel range', () => {
    for (const mmPerPixel of [0.002, 0.03, 0.4, 2, 30]) {
      const pixelsPerLine = chooseGridSpacing(mmPerPixel) / mmPerPixel;
      expect(pixelsPerLine).toBeGreaterThanOrEqual(8);
      expect(pixelsPerLine).toBeLessThanOrEqual(80);
    }
  });

  it('grows monotonically as you zoom out', () => {
    let prev = 0;
    for (const mmPerPixel of [0.01, 0.1, 1, 10, 100]) {
      const s = chooseGridSpacing(mmPerPixel);
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
  });

  it('survives a degenerate zoom', () => {
    expect(Number.isFinite(chooseGridSpacing(0))).toBe(true);
  });
});
