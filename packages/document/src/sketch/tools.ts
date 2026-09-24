import type { SketchEntityId, SketchGeometry, SketchToolKind, Vec2 } from '@cardstock/types';
import type { Sketch } from './sketch.js';
import {
  DEFAULT_INFERENCE, type InferenceOptions, inferForNewLine, snapToAxis, snapToPoint,
} from './inference.js';

/**
 * Snap radius in SCREEN pixels.
 *
 * What the user aims with is a mouse, so the target has to be a fixed size on screen —
 * roughly a large cursor tip. Converted to sketch units per zoom by `setScale`.
 */
const SNAP_PIXELS = 12;

/**
 * The drawing tools, as a state machine over a Sketch.
 *
 * Pure and headless: "what happens when you click at (12, 4) with the line tool active"
 * is sketch logic, not rendering, so it is decided here and tested without a browser.
 * The viewer's job is to turn pointer positions into sketch coordinates and draw the
 * preview this returns.
 */

/**
 * The tools this class implements. Defined in `@cardstock/types` so the registry and
 * the shell name the same set; `select`, `dimension` and `constrain` reach this class
 * only to be ignored, because they act on entities the caller picked with screen-space
 * hit testing this class deliberately knows nothing about.
 */
export type ToolKind = SketchToolKind;

/** What to draw as feedback before the click lands. */
export interface ToolPreview {
  readonly kind: ToolKind;
  /** Rubber-band geometry, in sketch coordinates. */
  readonly segments: readonly { from: Vec2; to: Vec2 }[];
  readonly circle?: { readonly centre: Vec2; readonly radius: number };
  /** A rubber-band arc, counter-clockwise from `start` to `end` about `centre`. */
  readonly arc?: { readonly centre: Vec2; readonly radius: number; readonly start: number; readonly end: number };
  /** The point this click would snap to, so the viewer can highlight it. */
  readonly snapPoint: SketchEntityId | null;
  /** Named so the user can see what is about to be assumed. */
  readonly inference: string | null;
}

export interface ToolResult {
  /** Ids of anything created by this click. */
  readonly created: readonly SketchEntityId[];
  /** True once the tool has finished a shape and is ready for a fresh one. */
  readonly completed: boolean;
}

export class SketchTools {
  #kind: ToolKind = 'select';
  /** Points placed so far in the shape being drawn. */
  #anchors: SketchEntityId[] = [];
  /**
   * Where the current polyline began.
   *
   * Tracked separately because `#anchors` is reset to the latest point after each
   * segment, so it cannot answer "did this click return to the start?" — which is how a
   * polyline knows it has closed.
   */
  #chainStart: SketchEntityId | null = null;

  constructor(
    private readonly sketch: Sketch,
    private options: InferenceOptions = DEFAULT_INFERENCE,
  ) {}

  get kind(): ToolKind { return this.#kind; }
  get isDrawing(): boolean { return this.#anchors.length > 0; }

  /** Switching tools abandons anything half-drawn. */
  setTool(kind: ToolKind): void {
    this.cancel();
    this.#kind = kind;
  }

  /**
   * Abandon the shape in progress.
   *
   * Points placed for it are removed too — a stray point left behind adds two degrees of
   * freedom the user never asked for and cannot see.
   */
  cancel(): void {
    for (const id of [...this.#anchors, ...(this.#chainStart ? [this.#chainStart] : [])]) {
      if (this.#isOrphan(id)) this.sketch.remove(id);
    }
    this.#anchors = [];
    this.#chainStart = null;
  }

  #isOrphan(id: SketchEntityId): boolean {
    return !this.sketch.geometry.some((entity) =>
      (entity.type === 'line' && (entity.p1 === id || entity.p2 === id))
      || (entity.type === 'circle' && entity.centre === id)
      || (entity.type === 'arc'
        && (entity.centre === id || entity.start === id || entity.end === id)));
  }

  /** Where a click would actually land, and what would be assumed. */
  preview(at: Vec2): ToolPreview {
    const snapPoint = snapToPoint(this.sketch.geometry, at, this.#anchors, this.options);
    const anchor = this.#anchorPosition();
    const axis = anchor && this.#kind === 'line'
      ? snapToAxis(anchor, at, this.options)
      : { position: at, axis: null as 'horizontal' | 'vertical' | null };
    const position = snapPoint ? this.#positionOf(snapPoint)! : axis.position;

    if (this.#kind === 'select' || this.#kind === 'dimension' || this.#kind === 'constrain') {
      return { kind: this.#kind, segments: [], snapPoint, inference: null };
    }
    if (this.#kind === 'arc' && anchor) {
      const centre = { x: (anchor.x + position.x) / 2, y: (anchor.y + position.y) / 2 };
      const start = Math.atan2(anchor.y - centre.y, anchor.x - centre.x);
      return {
        kind: this.#kind, segments: [{ from: anchor, to: position }],
        arc: { centre, radius: Math.hypot(position.x - anchor.x, position.y - anchor.y) / 2, start, end: start + Math.PI },
        snapPoint, inference: null,
      };
    }
    if (this.#kind === 'circle' && anchor) {
      return {
        kind: this.#kind,
        segments: [],
        circle: { centre: anchor, radius: Math.hypot(position.x - anchor.x, position.y - anchor.y) },
        snapPoint, inference: null,
      };
    }
    if (this.#kind === 'rectangle' && anchor) {
      return { kind: this.#kind, segments: rectangleSides(anchor, position), snapPoint, inference: null };
    }
    return {
      kind: this.#kind,
      segments: anchor ? [{ from: anchor, to: position }] : [],
      snapPoint,
      inference: snapPoint ? 'Coincident' : axis.axis === 'horizontal' ? 'Horizontal'
        : axis.axis === 'vertical' ? 'Vertical' : null,
    };
  }

  /**
   * Retune the snap radius for the current zoom.
   *
   * Snap distances are in SKETCH units, but what the user is aiming with is a mouse, in
   * pixels. A fixed 3mm radius is a comfortable target at one zoom, an impossible
   * sub-pixel one when zoomed out — which is why clicking an existing vertex to continue
   * a chain appeared to do nothing and left the profile open.
   */
  setScale(sketchUnitsPerPixel: number): void {
    if (!Number.isFinite(sketchUnitsPerPixel) || sketchUnitsPerPixel <= 0) return;
    this.options = {
      ...this.options,
      snapDistance: SNAP_PIXELS * sketchUnitsPerPixel,
    };
  }

  /** Commit a click. */
  click(at: Vec2): ToolResult {
    switch (this.#kind) {
      case 'select':
      case 'dimension':
      case 'constrain':
        return { created: [], completed: false };
      case 'line': return this.#clickLine(at);
      case 'rectangle': return this.#clickRectangle(at);
      case 'circle': return this.#clickCircle(at);
      case 'arc': return this.#clickArc(at);
      case 'trim': return this.#clickTrim(at);
    }
  }

  /**
   * Take away the piece of curve under the cursor.
   *
   * The piece is whatever lies between the points sitting on that curve — the same
   * division the profile builder traces — so trimming a circle that two lines touch
   * leaves the arc between them, and the radius dimension on it carries straight over.
   * A curve nothing touches has no pieces to choose between and simply goes.
   */
  #clickTrim(at: Vec2): ToolResult {
    const curve = this.#curveNear(at);
    if (!curve) return { created: [], completed: false };
    this.sketch.trim(curve, at);
    return { created: [], completed: true };
  }

  /** The curve within snapping distance of `at`, nearest first. */
  #curveNear(at: Vec2): SketchEntityId | null {
    let best: { id: SketchEntityId; distance: number } | null = null;
    for (const entity of this.sketch.geometry) {
      if (entity.type === 'point' || entity.external) continue;
      const distance = this.#distanceToCurve(entity, at);
      if (distance === null || distance > this.options.snapDistance) continue;
      if (!best || distance < best.distance) best = { id: entity.id, distance };
    }
    return best?.id ?? null;
  }

  #distanceToCurve(entity: SketchGeometry, at: Vec2): number | null {
    if (entity.type === 'line') {
      const a = this.#positionOf(entity.p1), b = this.#positionOf(entity.p2);
      if (!a || !b) return null;
      const dx = b.x - a.x, dy = b.y - a.y;
      const length = Math.hypot(dx, dy);
      if (length < 1e-9) return null;
      const t = Math.max(0, Math.min(1, ((at.x - a.x) * dx + (at.y - a.y) * dy) / (length * length)));
      return Math.hypot(at.x - (a.x + dx * t), at.y - (a.y + dy * t));
    }
    if (entity.type === 'point') return null;
    const centre = this.#positionOf(entity.centre);
    if (!centre) return null;
    const radial = Math.abs(Math.hypot(at.x - centre.x, at.y - centre.y) - entity.radius);
    if (entity.type === 'circle') return radial;
    // On an arc only where the arc actually runs; past its ends, measure to the end.
    const sweep = entity.endAngle - entity.startAngle;
    const direction = Math.sign(sweep) || 1;
    let offset = ((Math.atan2(at.y - centre.y, at.x - centre.x) - entity.startAngle) * direction) % (Math.PI * 2);
    if (offset < 0) offset += Math.PI * 2;
    if (offset <= Math.abs(sweep)) return radial;
    const end = (angle: number) => ({ x: centre.x + entity.radius * Math.cos(angle), y: centre.y + entity.radius * Math.sin(angle) });
    const s = end(entity.startAngle), e = end(entity.endAngle);
    return Math.min(Math.hypot(at.x - s.x, at.y - s.y), Math.hypot(at.x - e.x, at.y - e.y));
  }

  // ------------------------------------------------------------------ tools
  #clickLine(at: Vec2): ToolResult {
    const point = this.#placePoint(at);
    const previous = this.#anchors.at(-1);

    if (previous === undefined) {
      this.#anchors = [point];
      this.#chainStart = point;
      return { created: [point], completed: false };
    }

    const line = this.sketch.addLine(previous, point);
    // Infer only from the line just drawn, and only what the user plausibly meant.
    for (const inference of inferForNewLine(
      this.sketch.geometry, line, this.sketch.constraints, this.options,
    )) {
      this.sketch.addConstraint(inference.constraint);
    }

    // A chain that returns to where it started is finished; otherwise keep going, which
    // is how polylines are drawn everywhere.
    const closed = point === this.#chainStart;
    if (closed) { this.#anchors = []; this.#chainStart = null; }
    else this.#anchors = [point];
    return { created: [point, line], completed: closed };
  }

  #clickRectangle(at: Vec2): ToolResult {
    const corner = this.#placePoint(at);
    if (this.#anchors.length === 0) {
      this.#anchors.push(corner);
      return { created: [corner], completed: false };
    }

    const first = this.#anchors[0]!;
    const a = this.#positionOf(first)!;
    const c = this.#positionOf(corner)!;
    // Two more corners complete the rectangle; the two the user clicked are opposite.
    const b = this.sketch.addPoint(c.x, a.y);
    const d = this.sketch.addPoint(a.x, c.y);

    const lines = [
      this.sketch.addLine(first, b), this.sketch.addLine(b, corner),
      this.sketch.addLine(corner, d), this.sketch.addLine(d, first),
    ];
    // Constrain it as a rectangle rather than leaving four free lines that merely look
    // like one — otherwise the first drag turns it into a quadrilateral. One horizontal
    // (the bottom), one vertical (the left), and the other two parallel to those: the
    // same shape with the fewest rules, so a user relaxing it removes one thing.
    // Which line is "bottom" and "left" depends on the drag direction.
    const bottomFirst = a.y <= c.y;
    const leftFirst = a.x <= c.x;
    const bottom = bottomFirst ? lines[0]! : lines[2]!;
    const top = bottomFirst ? lines[2]! : lines[0]!;
    const left = leftFirst ? lines[3]! : lines[1]!;
    const right = leftFirst ? lines[1]! : lines[3]!;
    this.sketch.addConstraint({ type: 'horizontal', line: bottom });
    this.sketch.addConstraint({ type: 'vertical', line: left });
    this.sketch.addConstraint({ type: 'parallel', a: top, b: bottom });
    this.sketch.addConstraint({ type: 'parallel', a: right, b: left });

    this.#anchors = [];
    return { created: [first, b, corner, d, ...lines], completed: true };
  }

  /**
   * An arc from two clicks: its two ends.
   *
   * Each click either takes an existing point or makes one, so an arc drawn onto the
   * end of a line shares that point rather than stacking a second one on top. It
   * starts as a half circle running counter-clockwise from the first click, with a
   * driving SWEEP dimension — type 90 for a quarter circle, or −180 to put the same
   * arc on the other side of its ends — and a radius that follows from the two ends
   * and the sweep until a radius dimension says otherwise.
   *
   * There is no axis. An arc used to be built on one: a construction line between the
   * two clicks, two radii hung off the centre, and a sweep measured from the axis's
   * perpendicular bisector — which needed a rule for which side of the axis the bulge
   * fell on, another for when the arc's ends WERE the axis ends, and cascade rules so
   * deleting either took the other. An arc knows its own sweep; none of that scaffolding
   * was telling anyone anything the arc could not say itself.
   */
  #clickArc(at: Vec2): ToolResult {
    if (this.#anchors.length === 0) {
      const start = this.#placePoint(at);
      this.#anchors.push(start);
      return { created: [start], completed: false };
    }
    const startId = this.#anchors[0]!;
    const endId = this.#placePoint(at);
    if (endId === startId) return { created: [], completed: false };
    const a = this.#positionOf(startId)!, b = this.#positionOf(endId)!;
    const radius = Math.hypot(b.x - a.x, b.y - a.y) / 2;
    if (radius < 1e-6) return { created: [], completed: false };

    // A half circle on the two clicked ends: the centre is the midpoint of the chord.
    const centreAt = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const centre = this.sketch.addPoint(centreAt.x, centreAt.y);
    const startAngle = Math.atan2(a.y - centreAt.y, a.x - centreAt.x);
    const arc = this.sketch.addArc(centre, radius, startId, endId, startAngle, startAngle + Math.PI);
    const sweep = this.sketch.addConstraint({ type: 'sweep', entity: arc, value: 180 });
    this.#anchors = [];
    return { created: [startId, endId, centre, arc, sweep], completed: true };
  }

  #clickCircle(at: Vec2): ToolResult {
    if (this.#anchors.length === 0) {
      const centre = this.#placePoint(at);
      this.#anchors.push(centre);
      return { created: [centre], completed: false };
    }
    const centre = this.#anchors[0]!;
    const c = this.#positionOf(centre)!;
    const radius = Math.hypot(at.x - c.x, at.y - c.y);
    if (radius < 1e-6) return { created: [], completed: false }; // a click on the centre
    const circle = this.sketch.addCircle(centre, radius);
    this.#anchors = [];
    return { created: [circle], completed: true };
  }

  // ------------------------------------------------------------------ helpers
  /** Reuse an existing point when close enough, so shapes connect rather than overlap. */
  #placePoint(at: Vec2): SketchEntityId {
    // Only the point being drawn FROM is excluded: the chain's start must stay snappable,
    // because snapping back onto it is exactly how a polyline is closed.
    const snapped = snapToPoint(this.sketch.geometry, at, this.#anchors, this.options);
    if (snapped) return snapped;

    const anchor = this.#anchorPosition();
    const position = anchor && this.#kind === 'line'
      ? snapToAxis(anchor, at, this.options).position
      : at;
    return this.sketch.addPoint(position.x, position.y);
  }

  #anchorPosition(): Vec2 | null {
    const id = this.#anchors.at(-1);
    return id ? this.#positionOf(id) : null;
  }

  #positionOf(id: SketchEntityId): Vec2 | null {
    const entity = this.sketch.entity(id);
    return entity?.type === 'point' ? { x: entity.x, y: entity.y } : null;
  }
}

function rectangleSides(a: Vec2, c: Vec2): { from: Vec2; to: Vec2 }[] {
  const b = { x: c.x, y: a.y };
  const d = { x: a.x, y: c.y };
  return [{ from: a, to: b }, { from: b, to: c }, { from: c, to: d }, { from: d, to: a }];
}
