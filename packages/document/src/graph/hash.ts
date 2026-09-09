/**
 * Stable content hashing for the recompute cache.
 *
 * FNV-1a over a canonical serialisation. Not cryptographic — it only has to be
 * deterministic across runs and cheap enough to compute for every feature on every
 * recompute. Collisions would silently reuse the wrong geometry, so the canonical form
 * is deliberately unambiguous: keys sorted, types tagged, numbers normalised.
 */

/** Canonical string form. Key order never affects the result. */
export function canonicalize(value: unknown): string {
  if (value === null) return 'n';
  if (value === undefined) return 'u';
  switch (typeof value) {
    case 'number':
      // -0 and 0 must hash alike; NaN must be representable rather than throwing.
      if (Number.isNaN(value)) return '#NaN';
      if (value === 0) return '#0';
      return `#${value}`;
    case 'string': return `s${value.length}:${value}`;
    case 'boolean': return value ? 'T' : 'F';
    default: break;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value instanceof Map) {
    const entries = [...value.entries()].map(([k, v]) => [String(k), v] as const);
    entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return `M{${entries.map(([k, v]) => `${k}=${canonicalize(v)}`).join(',')}}`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${k}=${canonicalize(obj[k])}`).join(',')}}`;
}

export function hashString(text: string): string {
  // 64-bit-ish: two independent 32-bit FNV-1a lanes, so accidental collisions are
  // vanishingly unlikely across a document's worth of features.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 + c) >>> 0;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
    h2 ^= h2 >>> 13;
  }
  return (h1 >>> 0).toString(36).padStart(7, '0') + (h2 >>> 0).toString(36).padStart(7, '0');
}

export const contentHash = (value: unknown): string => hashString(canonicalize(value));
