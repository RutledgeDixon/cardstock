/**
 * The expression language behind parameters and feature dimensions.
 *
 * A real tokenizer and Pratt parser rather than `eval` or `new Function`: documents are
 * files that get shared, and an expression is untrusted input. It is also the only way
 * to answer "which parameters does this reference?", which the dependency graph needs.
 *
 * Trigonometry is in DEGREES. Every CAD package works that way and every user expects
 * `sin(30)` to be 0.5; radians here would be a foot-gun with no upside.
 */

export class ExpressionError extends Error {
  constructor(message: string, readonly position?: number) {
    super(message);
    this.name = 'ExpressionError';
  }
}

// ------------------------------------------------------------------ tokens
type TokenType = 'number' | 'ident' | 'op' | 'lparen' | 'rparen' | 'comma' | 'end';
interface Token { type: TokenType; value: string; pos: number }

const OPERATOR_CHARS = new Set(['+', '-', '*', '/', '%', '^']);

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }

    if (/[0-9.]/.test(c)) {
      const start = i;
      while (i < src.length && /[0-9.]/.test(src[i]!)) i++;
      // Scientific notation: 1e-3, 2.5E6
      if (src[i] === 'e' || src[i] === 'E') {
        const save = i;
        i++;
        if (src[i] === '+' || src[i] === '-') i++;
        if (i < src.length && /[0-9]/.test(src[i]!)) {
          while (i < src.length && /[0-9]/.test(src[i]!)) i++;
        } else {
          i = save; // not an exponent after all, e.g. `2 e`
        }
      }
      const text = src.slice(start, i);
      if ((text.match(/\./g) ?? []).length > 1) {
        throw new ExpressionError(`malformed number "${text}"`, start);
      }
      tokens.push({ type: 'number', value: text, pos: start });
      continue;
    }

    if (/[A-Za-z_]/.test(c)) {
      const start = i;
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i]!)) i++;
      tokens.push({ type: 'ident', value: src.slice(start, i), pos: start });
      continue;
    }

    if (OPERATOR_CHARS.has(c)) { tokens.push({ type: 'op', value: c, pos: i++ }); continue; }
    if (c === '(') { tokens.push({ type: 'lparen', value: c, pos: i++ }); continue; }
    if (c === ')') { tokens.push({ type: 'rparen', value: c, pos: i++ }); continue; }
    if (c === ',') { tokens.push({ type: 'comma', value: c, pos: i++ }); continue; }

    throw new ExpressionError(`unexpected character "${c}"`, i);
  }
  tokens.push({ type: 'end', value: '', pos: src.length });
  return tokens;
}

// ------------------------------------------------------------------ AST
export type Ast =
  | { kind: 'number'; value: number }
  | { kind: 'ref'; name: string }
  | { kind: 'unary'; op: '-' | '+'; operand: Ast }
  | { kind: 'binary'; op: string; left: Ast; right: Ast }
  | { kind: 'call'; name: string; args: Ast[] };

/** Left binding power. `^` is right-associative, so its right side parses at power-1. */
const BINDING_POWER: Record<string, number> = {
  '+': 1, '-': 1,
  '*': 2, '/': 2, '%': 2,
  '^': 4,
};
const UNARY_POWER = 3;

export function parse(src: string): Ast {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = (): Token => tokens[pos]!;
  const next = (): Token => tokens[pos++]!;

  function parseExpression(minPower = 0): Ast {
    let left = parsePrefix();
    for (;;) {
      const t = peek();
      if (t.type !== 'op') break;
      const power = BINDING_POWER[t.value];
      if (power === undefined || power < minPower) break;
      next();
      const rightPower = t.value === '^' ? power : power + 1; // ^ right-assoc
      const right = parseExpression(rightPower);
      left = { kind: 'binary', op: t.value, left, right };
    }
    return left;
  }

  function parsePrefix(): Ast {
    const t = next();
    if (t.type === 'number') {
      const value = Number(t.value);
      if (!Number.isFinite(value)) throw new ExpressionError(`bad number "${t.value}"`, t.pos);
      return { kind: 'number', value };
    }
    if (t.type === 'op' && (t.value === '-' || t.value === '+')) {
      return { kind: 'unary', op: t.value, operand: parseExpression(UNARY_POWER) };
    }
    if (t.type === 'lparen') {
      const inner = parseExpression(0);
      if (next().type !== 'rparen') throw new ExpressionError('expected ")"', t.pos);
      return inner;
    }
    if (t.type === 'ident') {
      if (peek().type === 'lparen') {
        next();
        const args: Ast[] = [];
        if (peek().type !== 'rparen') {
          for (;;) {
            args.push(parseExpression(0));
            if (peek().type === 'comma') { next(); continue; }
            break;
          }
        }
        if (next().type !== 'rparen') throw new ExpressionError('expected ")"', t.pos);
        return { kind: 'call', name: t.value, args };
      }
      return { kind: 'ref', name: t.value };
    }
    throw new ExpressionError(
      t.type === 'end' ? 'unexpected end of expression' : `unexpected "${t.value}"`,
      t.pos,
    );
  }

  const ast = parseExpression(0);
  if (peek().type !== 'end') {
    throw new ExpressionError(`unexpected "${peek().value}"`, peek().pos);
  }
  return ast;
}

// ------------------------------------------------------------------ evaluation
const DEG = Math.PI / 180;

const FUNCTIONS: Record<string, { arity: number | 'variadic'; fn: (...a: number[]) => number }> = {
  // Trig in degrees — CAD convention.
  sin: { arity: 1, fn: (x) => Math.sin(x! * DEG) },
  cos: { arity: 1, fn: (x) => Math.cos(x! * DEG) },
  tan: { arity: 1, fn: (x) => Math.tan(x! * DEG) },
  asin: { arity: 1, fn: (x) => Math.asin(x!) / DEG },
  acos: { arity: 1, fn: (x) => Math.acos(x!) / DEG },
  atan: { arity: 1, fn: (x) => Math.atan(x!) / DEG },
  atan2: { arity: 2, fn: (y, x) => Math.atan2(y!, x!) / DEG },
  sqrt: { arity: 1, fn: (x) => Math.sqrt(x!) },
  abs: { arity: 1, fn: (x) => Math.abs(x!) },
  floor: { arity: 1, fn: (x) => Math.floor(x!) },
  ceil: { arity: 1, fn: (x) => Math.ceil(x!) },
  round: { arity: 1, fn: (x) => Math.round(x!) },
  sign: { arity: 1, fn: (x) => Math.sign(x!) },
  log: { arity: 1, fn: (x) => Math.log(x!) },
  exp: { arity: 1, fn: (x) => Math.exp(x!) },
  pow: { arity: 2, fn: (x, y) => x! ** y! },
  hypot: { arity: 'variadic', fn: (...a) => Math.hypot(...a) },
  min: { arity: 'variadic', fn: (...a) => Math.min(...a) },
  max: { arity: 'variadic', fn: (...a) => Math.max(...a) },
  clamp: { arity: 3, fn: (x, lo, hi) => Math.min(Math.max(x!, lo!), hi!) },
};

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 };

export type Scope = (name: string) => number | undefined;

export function evaluate(ast: Ast, scope: Scope = () => undefined): number {
  switch (ast.kind) {
    case 'number':
      return ast.value;

    case 'ref': {
      const fromScope = scope(ast.name);
      if (fromScope !== undefined) {
        // Never trust the scope's return type. A Scope backed by a plain object would
        // resolve "constructor", "toString" or "__proto__" to host values straight off
        // Object.prototype; this is the choke point that stops that reaching geometry.
        if (typeof fromScope !== 'number' || !Number.isFinite(fromScope)) {
          throw new ExpressionError(`parameter "${ast.name}" is not a finite number`);
        }
        return fromScope;
      }
      const constant = Object.hasOwn(CONSTANTS, ast.name.toLowerCase())
        ? CONSTANTS[ast.name.toLowerCase()]
        : undefined;
      if (constant !== undefined) return constant;
      throw new ExpressionError(`unknown parameter "${ast.name}"`);
    }

    case 'unary': {
      const v = evaluate(ast.operand, scope);
      return ast.op === '-' ? -v : v;
    }

    case 'binary': {
      const l = evaluate(ast.left, scope);
      const r = evaluate(ast.right, scope);
      switch (ast.op) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '/':
          if (r === 0) throw new ExpressionError('division by zero');
          return l / r;
        case '%':
          if (r === 0) throw new ExpressionError('modulo by zero');
          return l % r;
        case '^': return l ** r;
        default: throw new ExpressionError(`unknown operator "${ast.op}"`);
      }
    }

    case 'call': {
      const def = Object.hasOwn(FUNCTIONS, ast.name.toLowerCase())
        ? FUNCTIONS[ast.name.toLowerCase()]
        : undefined;
      if (!def) throw new ExpressionError(`unknown function "${ast.name}"`);
      if (def.arity !== 'variadic' && def.arity !== ast.args.length) {
        throw new ExpressionError(
          `${ast.name}() takes ${def.arity} argument(s), got ${ast.args.length}`,
        );
      }
      if (def.arity === 'variadic' && ast.args.length === 0) {
        throw new ExpressionError(`${ast.name}() needs at least one argument`);
      }
      const result = def.fn(...ast.args.map((a) => evaluate(a, scope)));
      if (!Number.isFinite(result)) {
        throw new ExpressionError(`${ast.name}() produced a non-finite result`);
      }
      return result;
    }
  }
}

/**
 * Identifiers an expression reads, excluding built-in constants and function names.
 * This is what the dependency graph uses to wire parameter edges.
 */
export function referencedNames(ast: Ast): string[] {
  const found = new Set<string>();
  const walk = (node: Ast): void => {
    switch (node.kind) {
      case 'ref':
        if (!Object.hasOwn(CONSTANTS, node.name.toLowerCase())) found.add(node.name);
        break;
      case 'unary': walk(node.operand); break;
      case 'binary': walk(node.left); walk(node.right); break;
      case 'call': node.args.forEach(walk); break;
      case 'number': break;
    }
  };
  walk(ast);
  return [...found];
}

/** Parse + evaluate in one step. Throws ExpressionError on bad input. */
export function evaluateExpression(src: string, scope: Scope = () => undefined): number {
  return evaluate(parse(src), scope);
}
