import type { ProfileSegment, SketchGeometry, Vec2 } from '@cardstock/types';

/**
 * Turn solved sketch geometry into closed loops a kernel can make faces from.
 *
 * Adjacency is decided by POSITION, not by shared point ids. Two ends may be the same
 * point, or two distinct points held together by a coincident constraint — after solving
 * both look identical on screen, and a profile that worked one way but not the other
 * would be baffling.
 *
 * Construction geometry is excluded: it exists to constrain, not to enclose.
 */

export interface ProfileLoop {
  readonly segments: readonly ProfileSegment[];
  /** True for a full circle, which is closed without any chaining. */
  readonly closed: boolean;
  /** Positive when the loop runs counter-clockwise. */
  readonly signedArea: number;
}

export type { ProfileSegment };

export interface ProfileResult {
  readonly loops: readonly ProfileLoop[];
  /** Segments that belong to no closed loop, with why — shown to the user as gaps. */
  readonly openChains: readonly { readonly segments: readonly ProfileSegment[]; readonly reason: string }[];
}

const TOLERANCE = 1e-6;
const key = (p: Vec2): string =>
  `${Math.round(p.x / TOLERANCE)},${Math.round(p.y / TOLERANCE)}`;

const positionOf = (geometry: readonly SketchGeometry[], id: string): Vec2 | null => {
  const entity = geometry.find((e) => e.id === id);
  return entity?.type === 'point' ? { x: entity.x, y: entity.y } : null;
};

/** Shoelace area; its sign gives the winding direction. */
export function signedArea(segments: readonly ProfileSegment[]): number {
  let total = 0;
  for (const segment of segments) {
    if (segment.kind === 'circle') return Math.PI * segment.radius ** 2;
    total += segment.from.x * segment.to.y - segment.to.x * segment.from.y;
  }
  return total / 2;
}

export function buildProfile(geometry: readonly SketchGeometry[]): ProfileResult {
  const loops: ProfileLoop[] = [];
  const chainable: ProfileSegment[] = [];

  for (const entity of geometry) {
    // Points have no construction flag; only curves do.
    if (entity.type !== 'point' && entity.construction) continue;

    if (entity.type === 'circle') {
      const centre = positionOf(geometry, entity.centre);
      if (!centre) continue;
      const segment: ProfileSegment = { kind: 'circle', centre, radius: entity.radius };
      loops.push({ segments: [segment], closed: true, signedArea: signedArea([segment]) });
      continue;
    }

    if (entity.type === 'line') {
      const from = positionOf(geometry, entity.p1);
      const to = positionOf(geometry, entity.p2);
      // A zero-length line contributes nothing and would create a self-loop in the graph.
      if (!from || !to || key(from) === key(to)) continue;
      chainable.push({ kind: 'line', from, to });
      continue;
    }

    if (entity.type === 'arc') {
      const centre = positionOf(geometry, entity.centre);
      const from = positionOf(geometry, entity.start);
      const to = positionOf(geometry, entity.end);
      if (!centre || !from || !to) continue;
      chainable.push({
        kind: 'arc', centre, radius: entity.radius, from, to,
        startAngle: entity.startAngle, endAngle: entity.endAngle,
      });
    }
  }

  // --- walk chains of segments that share endpoints
  const remaining = new Set(chainable.map((_, i) => i));
  const byPoint = new Map<string, number[]>();
  chainable.forEach((segment, index) => {
    if (segment.kind === 'circle') return;
    for (const end of [segment.from, segment.to]) {
      const k = key(end);
      byPoint.set(k, [...(byPoint.get(k) ?? []), index]);
    }
  });

  const openChains: { segments: ProfileSegment[]; reason: string }[] = [];

  while (remaining.size > 0) {
    const startIndex = remaining.values().next().value as number;
    remaining.delete(startIndex);
    const first = chainable[startIndex]! as Extract<ProfileSegment, { from: Vec2 }>;

    const chain: ProfileSegment[] = [first];
    const startKey = key(first.from);
    let endKey = key(first.to);
    let closed = false;

    for (;;) {
      if (endKey === startKey) { closed = true; break; }
      const candidates = (byPoint.get(endKey) ?? []).filter((i) => remaining.has(i));
      if (candidates.length === 0) break;
      if (candidates.length > 1) {
        // A junction: three or more segments meet, so which way round is ambiguous.
        // Better to report the gap than to guess and silently make the wrong face.
        openChains.push({
          segments: chain,
          reason: 'more than two segments meet at a point, so the profile is ambiguous',
        });
        chain.length = 0;
        break;
      }
      const nextIndex = candidates[0]!;
      remaining.delete(nextIndex);
      const next = chainable[nextIndex]! as Extract<ProfileSegment, { from: Vec2 }>;
      // Segments may be drawn in either direction; follow whichever end connects.
      const flipped = key(next.from) !== endKey;
      chain.push(flipped ? reverse(next) : next);
      endKey = flipped ? key(next.from) : key(next.to);
    }

    if (chain.length === 0) continue;
    if (closed) {
      loops.push({ segments: chain, closed: true, signedArea: signedArea(chain) });
    } else {
      openChains.push({ segments: chain, reason: 'the profile does not close' });
    }
  }

  return { loops, openChains };
}

function reverse(segment: Extract<ProfileSegment, { from: Vec2 }>): ProfileSegment {
  if (segment.kind === 'line') return { kind: 'line', from: segment.to, to: segment.from };
  return {
    ...segment,
    from: segment.to,
    to: segment.from,
    startAngle: segment.endAngle,
    endAngle: segment.startAngle,
  };
}

/**
 * The outer boundary, by absolute area.
 *
 * Everything else is a hole. Nesting deeper than one level is not supported yet and
 * would need a containment test rather than a size comparison.
 */
export function outerLoop(loops: readonly ProfileLoop[]): ProfileLoop | null {
  if (loops.length === 0) return null;
  return loops.reduce((largest, loop) =>
    Math.abs(loop.signedArea) > Math.abs(largest.signedArea) ? loop : largest);
}
