import { describe, expect, it } from 'vitest';
import { DEFAULT_PRINTER, fitsBed, normaliseProfile, printEstimates, profileEnvironment } from './profile.js';
import { ParameterTable } from '../params/parameters.js';

describe('printer profile', () => {
  it('normalises junk to the defaults, field by field', () => {
    const p = normaliseProfile({ nozzle: 0.6, bed: { x: 300, y: 'wide' }, maxOverhang: 120, layer: -1 });
    expect(p.nozzle).toBe(0.6);
    expect(p.bed).toEqual({ x: 300, y: 220, z: 250 });
    expect(p.maxOverhang).toBe(89);
    expect(p.layer).toBe(0.2);
    expect(normaliseProfile(undefined)).toEqual(DEFAULT_PRINTER);
  });

  it('fits the bed in any orientation', () => {
    expect(fitsBed({ x: 240, y: 100, z: 100 }, DEFAULT_PRINTER)).toBe(true); // stand it up
    expect(fitsBed({ x: 240, y: 230, z: 100 }, DEFAULT_PRINTER)).toBe(false);
  });

  it('estimates mass and filament for a solid', () => {
    const { cm3, grams, metres } = printEstimates(10_000, DEFAULT_PRINTER);
    expect(cm3).toBe(10);
    expect(grams).toBeCloseTo(12.4);
    // 10 000 mm³ of 1.75 mm filament: area 2.405 mm², so 4.16 m.
    expect(metres).toBeCloseTo(4.158, 2);
  });
});

describe('expression environment', () => {
  it('nozzle is usable in expressions, and a parameter of the same name wins', () => {
    const table = new ParameterTable();
    table.setEnvironment(profileEnvironment(DEFAULT_PRINTER));
    table.set({ name: 'wall', expression: 'nozzle * 3', unit: 'mm' });
    expect(table.value('wall')).toBeCloseTo(1.2);
    expect(table.scope()('layer')).toBe(0.2);
    expect(table.scope()('unknown')).toBeUndefined();

    table.set({ name: 'nozzle', expression: '0.6', unit: 'mm' });
    expect(table.value('wall')).toBeCloseTo(1.8);

    table.setEnvironment({ nozzle: 0.8, layer: 0.3 });
    expect(table.value('wall')).toBeCloseTo(1.8); // still shadowed
    table.remove('nozzle');
    expect(table.value('wall')).toBeCloseTo(2.4);
  });
});
