import { describe, expect, it } from 'vitest';
import { weld } from './mesh.js';
import { rotationTaking, scoreOrientations } from './orientation.js';

/** An L-bracket: a base plate with a wall standing on one edge. Wound outward. */
function bracket() {
  const p: number[] = [], idx: number[] = [];
  const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => {
    const quad = (a: number[], b: number[], c: number[], d: number[]) => {
      const base = p.length / 3;
      p.push(...a, ...b, ...c, ...d);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]);
    quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
    quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
    quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]);
    quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]);
    quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);
  };
  // Two overlapping boxes rather than a true union: the internal faces this leaves
  // are all vertical or facing up, so they cannot masquerade as overhangs.
  box(0, 0, 0, 60, 30, 3);    // plate
  box(0, 0, 0, 3, 30, 20);    // wall along x=0, standing up
  return weld(p, idx);
}

describe('orientation scoring', () => {
  it('puts the bracket flat on its plate, not on its wall edge', () => {
    const [best] = scoreOrientations(bracket(), { maxOverhangDeg: 45, layer: 0.2 });
    expect(best).toBeDefined();
    // As modelled it already sits on its plate: down is -z, nothing overhangs.
    expect(best!.down[2]).toBeCloseTo(-1, 3);
    expect(best!.overhangArea).toBe(0);
    // The plate's underside plus the wall box's own bottom, which overlaps it.
    expect(best!.contactArea).toBeCloseTo(60 * 30 + 3 * 30, 3);
    expect(best!.height).toBeCloseTo(20, 6);
  });

  it('a candidate with the wall hanging out scores worse and reports support', () => {
    const all = scoreOrientations(bracket(), { maxOverhangDeg: 45, layer: 0.2, limit: 20 });
    // Upside down: the plate's underside becomes the top, and the wall hangs from it.
    const flipped = all.find((s) => s.down[2] > 0.999);
    expect(flipped).toBeDefined();
    expect(flipped!.overhangArea).toBeGreaterThan(0);
    expect(flipped!.supportVolume).toBeGreaterThan(0);
    expect(flipped!.score).toBeGreaterThan(all[0]!.score);
  });

  it('rotations take the chosen direction to straight down', () => {
    for (const from of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1], [0.6, 0, 0.8]] as const) {
      const m = rotationTaking([...from] as [number, number, number], [0, 0, -1]);
      const r = [
        m[0]! * from[0] + m[4]! * from[1] + m[8]! * from[2],
        m[1]! * from[0] + m[5]! * from[1] + m[9]! * from[2],
        m[2]! * from[0] + m[6]! * from[1] + m[10]! * from[2],
      ];
      expect(r[0]).toBeCloseTo(0, 9);
      expect(r[1]).toBeCloseTo(0, 9);
      expect(r[2]).toBeCloseTo(-1, 9);
    }
  });
});
