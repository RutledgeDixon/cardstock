import { describe, expect, it } from 'vitest';
import { canonicalize, contentHash, hashString } from './hash.js';

describe('canonicalize', () => {
  it('is insensitive to key order', () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
  });

  it('is sensitive to structure, not just content', () => {
    // A cache collision here would silently hand back the wrong geometry.
    expect(canonicalize({ a: 1 })).not.toBe(canonicalize({ a: '1' }));
    expect(canonicalize([1, 2])).not.toBe(canonicalize({ 0: 1, 1: 2 }));
    expect(canonicalize(['a', 'b'])).not.toBe(canonicalize(['ab']));
    expect(canonicalize(null)).not.toBe(canonicalize(undefined));
    expect(canonicalize(0)).not.toBe(canonicalize(false));
  });

  it('treats -0 and 0 as the same value', () => {
    expect(canonicalize(-0)).toBe(canonicalize(0));
  });

  it('represents NaN rather than throwing', () => {
    expect(() => canonicalize(NaN)).not.toThrow();
  });

  it('handles nesting and Maps', () => {
    const a = canonicalize({ x: [1, { y: new Map([['k', 2]]) }] });
    const b = canonicalize({ x: [1, { y: new Map([['k', 2]]) }] });
    expect(a).toBe(b);
  });
});

describe('contentHash', () => {
  it('is stable across calls', () => {
    const value = { type: 'box', values: { dx: 40, dy: 30 }, inputs: { base: 'abc' } };
    expect(contentHash(value)).toBe(contentHash({ ...value }));
  });

  it('changes when any input changes', () => {
    const base = contentHash({ type: 'box', values: { dx: 40 } });
    expect(contentHash({ type: 'box', values: { dx: 40.0001 } })).not.toBe(base);
    expect(contentHash({ type: 'cylinder', values: { dx: 40 } })).not.toBe(base);
  });

  it('avoids collisions across a realistic spread of feature inputs', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 4000; i++) {
      seen.add(contentHash({
        type: ['box', 'cylinder', 'cut', 'fillet'][i % 4],
        values: { dx: i * 0.5, dy: 30, dz: i % 7 },
        inputs: { base: `h${i % 13}` },
      }));
    }
    expect(seen.size).toBe(4000);
  });

  it('produces a short, printable key', () => {
    const h = hashString('anything');
    expect(h).toMatch(/^[0-9a-z]+$/);
    expect(h.length).toBeLessThanOrEqual(16);
  });
});
