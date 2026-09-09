import { type Ast, ExpressionError, evaluate, parse, referencedNames } from './expression.js';

/**
 * Named parameters with expressions.
 *
 * This is what makes "change an early value and everything follows" true at the numeric
 * level: a parameter may be a literal (`40`) or an expression over other parameters
 * (`wall * 3`, `boltM3 + clearance`).
 */

export type Unit = 'mm' | 'deg' | 'number';

export interface Parameter {
  readonly name: string;
  readonly expression: string;
  readonly unit: Unit;
  readonly description?: string;
}

export type ParameterValue =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly error: string };

const RESERVED = new Set([
  'pi', 'e', 'tau',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'sqrt', 'abs',
  'floor', 'ceil', 'round', 'sign', 'log', 'exp', 'pow', 'hypot', 'min', 'max', 'clamp',
]);

export function validateParameterName(name: string): string | null {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return `"${name}" is not a valid name (letters, digits and underscore; cannot start with a digit)`;
  }
  if (RESERVED.has(name.toLowerCase())) {
    return `"${name}" is reserved by the expression language`;
  }
  return null;
}

export class ParameterTable {
  /** Map, never a plain object — see the prototype-leak test in expression.test.ts. */
  readonly #params = new Map<string, Parameter>();
  #cache: Map<string, ParameterValue> | null = null;

  get size(): number { return this.#params.size; }
  has(name: string): boolean { return this.#params.has(name); }
  get(name: string): Parameter | undefined { return this.#params.get(name); }
  names(): string[] { return [...this.#params.keys()]; }
  all(): Parameter[] { return [...this.#params.values()]; }

  /** @returns an error message, or null on success. */
  set(param: Parameter): string | null {
    const nameError = validateParameterName(param.name);
    if (nameError) return nameError;
    try {
      parse(param.expression);
    } catch (e) {
      return e instanceof ExpressionError ? e.message : String(e);
    }
    this.#params.set(param.name, param);
    this.#cache = null;
    return null;
  }

  remove(name: string): boolean {
    const removed = this.#params.delete(name);
    if (removed) this.#cache = null;
    return removed;
  }

  clear(): void {
    this.#params.clear();
    this.#cache = null;
  }

  /** Call after mutating a Parameter in place (the document does not, but be safe). */
  invalidate(): void { this.#cache = null; }

  /**
   * Evaluate everything, resolving references between parameters.
   *
   * Cycles produce an error on each participating parameter rather than hanging or
   * blowing the stack, and a parameter that depends on a broken one reports *why* it is
   * broken rather than just "unknown parameter".
   */
  evaluateAll(): Map<string, ParameterValue> {
    if (this.#cache) return this.#cache;

    const results = new Map<string, ParameterValue>();
    const asts = new Map<string, Ast>();
    const state = new Map<string, 'visiting' | 'done'>();

    for (const [name, p] of this.#params) {
      try {
        asts.set(name, parse(p.expression));
      } catch (e) {
        results.set(name, { ok: false, error: e instanceof Error ? e.message : String(e) });
        state.set(name, 'done');
      }
    }

    const resolve = (name: string): ParameterValue => {
      const existing = results.get(name);
      if (existing) return existing;

      if (state.get(name) === 'visiting') {
        const err = { ok: false as const, error: `circular reference involving "${name}"` };
        results.set(name, err);
        return err;
      }

      const ast = asts.get(name);
      if (!ast) return { ok: false, error: `unknown parameter "${name}"` };

      state.set(name, 'visiting');
      let out: ParameterValue;
      try {
        out = {
          ok: true,
          value: evaluate(ast, (ref) => {
            if (!this.#params.has(ref)) return undefined; // fall through to constants
            const r = resolve(ref);
            if (!r.ok) throw new ExpressionError(`"${ref}" is invalid: ${r.error}`);
            return r.value;
          }),
        };
      } catch (e) {
        out = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      state.set(name, 'done');
      // A cycle detected deeper down may already have recorded an error for this name;
      // that diagnosis is the more useful one, so do not overwrite it.
      const recorded = results.get(name);
      if (recorded) return recorded;
      results.set(name, out);
      return out;
    };

    for (const name of this.#params.keys()) resolve(name);
    this.#cache = results;
    return results;
  }

  /** Numeric scope for evaluating feature expressions against these parameters. */
  scope(): (name: string) => number | undefined {
    const values = this.evaluateAll();
    return (name) => {
      const v = values.get(name);
      return v?.ok ? v.value : undefined;
    };
  }

  value(name: string): number | undefined {
    const v = this.evaluateAll().get(name);
    return v?.ok ? v.value : undefined;
  }

  /** Direct parameter-to-parameter references, for the dependency graph. */
  dependenciesOf(name: string): string[] {
    const p = this.#params.get(name);
    if (!p) return [];
    try {
      return referencedNames(parse(p.expression)).filter((n) => this.#params.has(n));
    } catch {
      return [];
    }
  }

  /** Every parameter that is currently broken, with its reason. */
  errors(): Map<string, string> {
    const out = new Map<string, string>();
    for (const [name, v] of this.evaluateAll()) if (!v.ok) out.set(name, v.error);
    return out;
  }
}
