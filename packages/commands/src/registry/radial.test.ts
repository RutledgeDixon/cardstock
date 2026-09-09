import { describe, expect, it } from 'vitest';
import type { Command } from './command.js';
import { layoutRadial, sectorFromVector, sectorOffset } from './radial.js';
import type { ResolvedCommand } from './registry.js';

const cmd = (id: string, sector?: number): Command => ({
  id, title: id, icon: '·', contexts: ['face'],
  ...(sector !== undefined ? { sector: { face: sector } } : {}),
  enabled: () => true,
  run: () => {},
});

const resolved = (command: Command, sector?: number): ResolvedCommand =>
  ({ command, enabled: true, ...(sector !== undefined ? { sector } : {}) });

describe('stable sectors', () => {
  it('honours a declared sector', () => {
    const slots = layoutRadial([resolved(cmd('fillet', 2), 2)]);
    expect(slots[2]!.command!.id).toBe('fillet');
  });

  it('keeps a command in the same direction whatever else is present', () => {
    // The entire value of a pie menu: learn the flick once, it never moves.
    const alone = layoutRadial([resolved(cmd('fillet', 6), 6)]);
    const crowded = layoutRadial([
      resolved(cmd('a')), resolved(cmd('b')), resolved(cmd('c')),
      resolved(cmd('fillet', 6), 6), resolved(cmd('d')),
    ]);
    expect(alone[6]!.command!.id).toBe('fillet');
    expect(crowded[6]!.command!.id).toBe('fillet');
  });

  it('fills undeclared commands into free sectors without displacing declared ones', () => {
    const slots = layoutRadial([
      resolved(cmd('pinned', 3), 3), resolved(cmd('x')), resolved(cmd('y')),
    ]);
    expect(slots[3]!.command!.id).toBe('pinned');
    expect(slots.filter((s) => s.command !== null)).toHaveLength(3);
  });

  it('always returns exactly eight slots', () => {
    expect(layoutRadial([])).toHaveLength(8);
    expect(layoutRadial([resolved(cmd('a'))])).toHaveLength(8);
  });
});

describe('overflow is flat, never nested', () => {
  const many = Array.from({ length: 14 }, (_, i) => resolved(cmd(`c${i}`)));

  it('collects the remainder into a single More slot', () => {
    const slots = layoutRadial(many);
    const more = slots.find((s) => s.overflow !== undefined);
    expect(more).toBeDefined();
    expect(more!.command).toBeNull();
    expect(more!.overflow!.length).toBeGreaterThan(0);
  });

  it('places seven commands plus More, losing none', () => {
    const slots = layoutRadial(many);
    const placed = slots.filter((s) => s.command !== null).length;
    const overflowed = slots.find((s) => s.overflow)!.overflow!.length;
    expect(placed + overflowed).toBe(many.length);
  });

  it('does not reserve More when everything fits', () => {
    const slots = layoutRadial(Array.from({ length: 8 }, (_, i) => resolved(cmd(`c${i}`))));
    expect(slots.some((s) => s.overflow !== undefined)).toBe(false);
    expect(slots.filter((s) => s.command !== null)).toHaveLength(8);
  });

  it('does not let overflow displace a command that had a home', () => {
    const nine = Array.from({ length: 9 }, (_, i) => resolved(cmd(`c${i}`)));
    const slots = layoutRadial(nine);
    expect(slots.filter((s) => s.command !== null)).toHaveLength(7);
    expect(slots.find((s) => s.overflow)!.overflow).toHaveLength(2);
  });
});

describe('flick direction', () => {
  it('maps screen vectors to sectors, north first and clockwise', () => {
    expect(sectorFromVector(0, -50)).toBe(0);   // up
    expect(sectorFromVector(50, -50)).toBe(1);  // up-right
    expect(sectorFromVector(50, 0)).toBe(2);    // right
    expect(sectorFromVector(0, 50)).toBe(4);    // down
    expect(sectorFromVector(-50, 0)).toBe(6);   // left
  });

  it('ignores a flick too small to be deliberate', () => {
    expect(sectorFromVector(2, 3)).toBeNull();
    expect(sectorFromVector(0, 0)).toBeNull();
  });

  it('round-trips through sectorOffset', () => {
    for (let sector = 0; sector < 8; sector++) {
      const { x, y } = sectorOffset(sector);
      expect(sectorFromVector(x * 60, y * 60)).toBe(sector);
    }
  });
});
