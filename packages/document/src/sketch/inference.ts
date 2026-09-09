import type {
  NewSketchConstraint, SketchConstraint, SketchEntityId, SketchGeometry, Vec2,
} from '@cardstock/types';

/**
 * Constraints inferred while drawing.
 *
 * This is what decides whether sketching feels good. Nobody wants to place a horizontal
 * constraint on a line they drew horizontally on purpose — the sketcher should notice.
 * The rules are deliberately conservative: an inference the user did not want is worse
 * than one they have to add by hand, because it silently changes what the sketch means.
 *
 * Pure functions over geometry, so the thresholds can be tuned against tests rather than
 * by feel alone.
 */

export interface InferenceOptions {
  /** How close, in sketch mm, counts as "the same point". */
  readonly snapDistance: number;
  /** How near to axis-aligned, in degrees, counts as deliberate. */
  readonly angleTolerance: number;
}

export const DEFAULT_INFERENCE: InferenceOptions = {
  snapDistance: 3,
  angleTolerance: 4,
};

export interface Inference {
  /** A constraint to add, without its id. */
  readonly constraint: NewSketchConstraint;
  /** Shown while drawing, so the user can see what is about to be assumed. */
  readonly label: string;
}

const positionOf = (
  geometry: readonly SketchGeometry[], id: SketchEntityId,
): Vec2 | null => {
  const entity = geometry.find((e) => e.id === id);
  return entity?.type === 'point' ? { x: entity.x, y: entity.y } : null;
};

/**
 * An existing point close enough to `at` to be the same point.
 *
 * Returns the CLOSEST rather than the first: with two candidates in range, snapping to
 * whichever happened to be created first is arbitrary and feels broken.
 */
export function snapToPoint(
  geometry: readonly SketchGeometry[],
  at: Vec2,
  exclude: readonly SketchEntityId[] = [],
  options: InferenceOptions = DEFAULT_INFERENCE,
): SketchEntityId | null {
  let best: { id: SketchEntityId; distance: number } | null = null;
  for (const entity of geometry) {
    if (entity.type !== 'point' || exclude.includes(entity.id)) continue;
    const d = Math.hypot(entity.x - at.x, entity.y - at.y);
    if (d <= options.snapDistance && (!best || d < best.distance)) {
      best = { id: entity.id, distance: d };
    }
  }
  return best?.id ?? null;
}

/** Horizontal or vertical, when a line is close enough to axis-aligned to have meant it. */
export function inferAxisAlignment(
  geometry: readonly SketchGeometry[],
  lineId: SketchEntityId,
  options: InferenceOptions = DEFAULT_INFERENCE,
): Inference | null {
  const line = geometry.find((e) => e.id === lineId);
  if (line?.type !== 'line') return null;
  const a = positionOf(geometry, line.p1);
  const b = positionOf(geometry, line.p2);
  if (!a || !b) return null;

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  // A zero-length line has no direction to infer from, and the angle would be noise.
  if (length < 1e-6) return null;

  const degrees = Math.abs((Math.atan2(dy, dx) * 180) / Math.PI);
  const fromHorizontal = Math.min(degrees, 180 - degrees);
  const fromVertical = Math.abs(degrees - 90);

  if (fromHorizontal <= options.angleTolerance) {
    return { constraint: { type: 'horizontal', line: lineId }, label: 'Horizontal' };
  }
  if (fromVertical <= options.angleTolerance) {
    return { constraint: { type: 'vertical', line: lineId }, label: 'Vertical' };
  }
  return null;
}

/**
 * Everything worth inferring for a line the user has just drawn.
 *
 * Only ONE axis alignment is ever suggested, and never alongside a coincidence that
 * already determines the same freedom — over-eager inference is how a sketch becomes
 * over-constrained the moment it is drawn.
 */
export function inferForNewLine(
  geometry: readonly SketchGeometry[],
  lineId: SketchEntityId,
  existingConstraints: readonly SketchConstraint[] = [],
  options: InferenceOptions = DEFAULT_INFERENCE,
): Inference[] {
  const alignment = inferAxisAlignment(geometry, lineId, options);
  if (!alignment) return [];

  const alreadyAligned = existingConstraints.some(
    (c) => (c.type === 'horizontal' || c.type === 'vertical')
      && (c as { line: string }).line === lineId,
  );
  return alreadyAligned ? [] : [alignment];
}

/** Snap a position to axis alignment with an anchor, for drawing feedback. */
export function snapToAxis(
  anchor: Vec2,
  at: Vec2,
  options: InferenceOptions = DEFAULT_INFERENCE,
): { position: Vec2; axis: 'horizontal' | 'vertical' | null } {
  const dx = at.x - anchor.x;
  const dy = at.y - anchor.y;
  if (Math.hypot(dx, dy) < 1e-9) return { position: at, axis: null };

  const degrees = Math.abs((Math.atan2(dy, dx) * 180) / Math.PI);
  const fromHorizontal = Math.min(degrees, 180 - degrees);
  const fromVertical = Math.abs(degrees - 90);

  if (fromHorizontal <= options.angleTolerance) {
    return { position: { x: at.x, y: anchor.y }, axis: 'horizontal' };
  }
  if (fromVertical <= options.angleTolerance) {
    return { position: { x: anchor.x, y: at.y }, axis: 'vertical' };
  }
  return { position: at, axis: null };
}
