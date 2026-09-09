import { beforeEach, describe, expect, it } from 'vitest';
import { ParameterTable, validateParameterName } from './parameters.js';

let t: ParameterTable;
beforeEach(() => { t = new ParameterTable(); });

const set = (name: string, expression: string) =>
  t.set({ name, expression, unit: 'mm' });

describe('evaluation', () => {
  it('resolves chains of references', () => {
    set('nozzle', '0.4');
    set('wall', 'nozzle * 3');
    set('shell', 'wall + nozzle');
    expect(t.value('wall')).toBeCloseTo(1.2, 12);
    expect(t.value('shell')).toBeCloseTo(1.6, 12);
  });

  it('reflects an edit through everything downstream', () => {
    set('nozzle', '0.4');
    set('wall', 'nozzle * 3');
    expect(t.value('wall')).toBeCloseTo(1.2, 12);
    set('nozzle', '0.6'); // the whole point of the feature
    expect(t.value('wall')).toBeCloseTo(1.8, 12);
  });

  it('resolves regardless of insertion order', () => {
    set('a', 'b * 2'); // forward reference
    set('b', '5');
    expect(t.value('a')).toBe(10);
  });

  it('caches until something changes', () => {
    set('x', '2');
    const first = t.evaluateAll();
    expect(t.evaluateAll()).toBe(first); // same object: cached
    set('y', '3');
    expect(t.evaluateAll()).not.toBe(first);
  });
});

describe('cycles', () => {
  it('reports a direct cycle instead of hanging', () => {
    set('a', 'b');
    set('b', 'a');
    const errors = t.errors();
    expect(errors.size).toBeGreaterThan(0);
    expect([...errors.values()].join(' ')).toMatch(/circular reference/);
  });

  it('reports a longer cycle', () => {
    set('a', 'b + 1');
    set('b', 'c + 1');
    set('c', 'a + 1');
    expect([...t.errors().values()].join(' ')).toMatch(/circular reference/);
  });

  it('reports self-reference', () => {
    set('a', 'a + 1');
    expect(t.errors().get('a')).toMatch(/circular reference/);
  });

  it('leaves unrelated parameters working', () => {
    set('a', 'b');
    set('b', 'a');
    set('fine', '42');
    expect(t.value('fine')).toBe(42);
    expect(t.errors().has('fine')).toBe(false);
  });
});

describe('error propagation', () => {
  it('explains WHY a dependent is broken, not just that a name is unknown', () => {
    set('base', '1 / 0');
    set('derived', 'base * 2');
    expect(t.errors().get('base')).toMatch(/division by zero/);
    // The useful message names the upstream culprit.
    expect(t.errors().get('derived')).toMatch(/"base" is invalid/);
  });

  it('keeps a broken parameter from producing a value', () => {
    set('bad', 'nope + 1');
    expect(t.value('bad')).toBeUndefined();
  });
});

describe('names', () => {
  it('rejects invalid identifiers', () => {
    expect(validateParameterName('2wide')).toMatch(/not a valid name/);
    expect(validateParameterName('has space')).toMatch(/not a valid name/);
    expect(validateParameterName('')).toMatch(/not a valid name/);
    expect(validateParameterName('wall_1')).toBeNull();
  });

  it('rejects names that would shadow the expression language', () => {
    // Allowing `sin` as a parameter makes sin(x) ambiguous to read.
    expect(validateParameterName('sin')).toMatch(/reserved/);
    expect(validateParameterName('pi')).toMatch(/reserved/);
    expect(validateParameterName('Max')).toMatch(/reserved/);
  });

  it('refuses to store a parameter with a bad name or expression', () => {
    expect(t.set({ name: '2bad', expression: '1', unit: 'mm' })).toMatch(/not a valid name/);
    expect(t.set({ name: 'ok', expression: '1 +', unit: 'mm' })).toBeTruthy();
    expect(t.size).toBe(0);
  });
});

describe('scope and dependencies', () => {
  it('exposes a scope for feature expressions', () => {
    set('w', '40');
    const scope = t.scope();
    expect(scope('w')).toBe(40);
    expect(scope('missing')).toBeUndefined();
  });

  it('lists direct parameter references only', () => {
    set('a', '1');
    set('b', '2');
    set('c', 'a + b + pi + sqrt(4)');
    expect(t.dependenciesOf('c').sort()).toEqual(['a', 'b']);
  });

  it('ignores references to parameters that do not exist', () => {
    set('c', 'a + ghost');
    expect(t.dependenciesOf('c')).toEqual([]);
  });
});
