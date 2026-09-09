import { describe, expect, it } from 'vitest';
import { ExpressionError, evaluateExpression, parse, referencedNames } from './expression.js';

const ev = (src: string, scope: Record<string, number> = {}) =>
  evaluateExpression(src, (n) => scope[n]);

describe('arithmetic', () => {
  it('respects precedence and associativity', () => {
    expect(ev('2 + 3 * 4')).toBe(14);
    expect(ev('(2 + 3) * 4')).toBe(20);
    expect(ev('10 - 3 - 2')).toBe(5); // left-assoc
    expect(ev('2 ^ 3 ^ 2')).toBe(512); // right-assoc: 2^(3^2)
    expect(ev('-2 ^ 2')).toBe(-4); // unary binds looser than ^, as in maths
    expect(ev('7 % 3')).toBe(1);
  });

  it('handles unary and nested signs', () => {
    expect(ev('-5')).toBe(-5);
    expect(ev('--5')).toBe(5);
    expect(ev('3 * -2')).toBe(-6);
    expect(ev('+4')).toBe(4);
  });

  it('parses decimals and scientific notation', () => {
    expect(ev('0.5')).toBe(0.5);
    expect(ev('.5 + 1')).toBe(1.5);
    expect(ev('1e3')).toBe(1000);
    expect(ev('2.5e-2')).toBeCloseTo(0.025, 12);
  });
});

describe('functions', () => {
  it('does trigonometry in degrees, as every CAD package does', () => {
    expect(ev('sin(30)')).toBeCloseTo(0.5, 12);
    expect(ev('cos(60)')).toBeCloseTo(0.5, 12);
    expect(ev('atan2(1, 1)')).toBeCloseTo(45, 12);
    expect(ev('asin(0.5)')).toBeCloseTo(30, 12);
  });

  it('supports the practical set', () => {
    expect(ev('sqrt(16)')).toBe(4);
    expect(ev('max(3, 9, 5)')).toBe(9);
    expect(ev('min(3, 9, 5)')).toBe(3);
    expect(ev('clamp(15, 0, 10)')).toBe(10);
    expect(ev('hypot(3, 4)')).toBe(5);
    expect(ev('round(2.6)')).toBe(3);
  });

  it('knows pi', () => {
    expect(ev('pi')).toBeCloseTo(Math.PI, 12);
    expect(ev('2 * pi')).toBeCloseTo(Math.PI * 2, 12);
  });
});

describe('parameter references', () => {
  it('resolves from scope', () => {
    expect(ev('wall * 3', { wall: 0.4 })).toBeCloseTo(1.2, 12);
    expect(ev('bolt + clearance', { bolt: 3, clearance: 0.4 })).toBeCloseTo(3.4, 12);
  });

  it('reports the names it reads, so the graph can wire edges', () => {
    expect(referencedNames(parse('wall * 3 + nozzle')).sort()).toEqual(['nozzle', 'wall']);
    expect(referencedNames(parse('max(a, b) + sin(c)')).sort()).toEqual(['a', 'b', 'c']);
  });

  it('does not treat constants or function names as parameters', () => {
    expect(referencedNames(parse('pi * 2'))).toEqual([]);
    expect(referencedNames(parse('sqrt(x)'))).toEqual(['x']);
  });

  it('lets a parameter shadow a constant', () => {
    expect(ev('e', { e: 7 })).toBe(7);
  });
});

describe('errors are actionable, never silent', () => {
  const bad = (src: string, scope: Record<string, number> = {}) => () => ev(src, scope);

  it('rejects unknown names', () => {
    expect(bad('width + 1')).toThrow(/unknown parameter "width"/);
    expect(bad('frobnicate(2)')).toThrow(/unknown function "frobnicate"/);
  });

  it('rejects malformed input', () => {
    expect(bad('2 +')).toThrow(ExpressionError);
    expect(bad('(2 + 3')).toThrow(/expected "\)"/);
    expect(bad('2 3')).toThrow(/unexpected/);
    expect(bad('1.2.3')).toThrow(/malformed number/);
    expect(bad('2 $ 3')).toThrow(/unexpected character/);
    expect(bad('')).toThrow(/unexpected end/);
  });

  it('rejects division by zero rather than yielding Infinity', () => {
    // Infinity would flow silently into geometry and fail somewhere far away.
    expect(bad('1 / 0')).toThrow(/division by zero/);
    expect(bad('5 % 0')).toThrow(/modulo by zero/);
  });

  it('rejects wrong arity', () => {
    expect(bad('sqrt(1, 2)')).toThrow(/takes 1 argument/);
    expect(bad('max()')).toThrow(/at least one argument/);
  });

  it('rejects non-finite results', () => {
    expect(bad('sqrt(-1)')).toThrow(/non-finite/);
    expect(bad('log(-1)')).toThrow(/non-finite/);
  });

  it('cannot reach the host environment', () => {
    // The whole reason this is a parser and not eval().
    expect(bad('globalThis')).toThrow(/unknown parameter/);
    expect(bad('process')).toThrow(/unknown parameter/);
    expect(bad('__proto__')).toThrow(ExpressionError);
  });

  it('refuses inherited Object.prototype members leaked by a naive scope', () => {
    // A Scope backed by a plain object resolves "constructor" to Object itself rather
    // than undefined. The evaluator must reject that instead of passing a function
    // along as if it were a dimension.
    const naiveScope = (name: string) => ({} as Record<string, number>)[name];
    for (const src of ['constructor', 'toString', 'valueOf']) {
      expect(() => evaluateExpression(src, naiveScope)).toThrow(ExpressionError);
    }
  });

  it('rejects a scope that returns NaN', () => {
    expect(() => evaluateExpression('x', () => NaN)).toThrow(/not a finite number/);
  });
});
