import type { SketchEntityId, Vec2 } from '@cardstock/types';
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
 * `select` and `dimension` create no geometry — they act on entities the caller has
 * picked, which needs screen-space hit testing this class deliberately knows nothing
 * about. They are listed here so the tool set is one enumeration rather than two.
 */
export type ToolKind = 'select' | 'line' | 'rectangle' | 'circle' | 'arc' | 'dimension' | 'constrain';

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
    }
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
   * An arc from two clicks: the ends of its axis.
   *
   * It starts as a half circle — the axis is a diameter, the centre its midpoint — and
   * runs counter-clockwise from the first click. The arc's own ends are separate points
   * that start on the axis ends and move round the circle when the sweep changes; the
   * centre stays put unless it is dragged along the bisector or the axis is edited.
   * The axis and the two radii are dotted construction lines to constrain against,
   * and the sweep is a dimension from the start: type −90 to put a quarter circle on
   * the other side of the axis.
   */
  #clickArc(at: Vec2): ToolResult {
    if (this.#anchors.length === 0) {
      const existing = new Set(this.sketch.geometry.map((e) => e.id));
      const start = this.#placePoint(at);
      this.#anchors.push(start);
      this.#arcSnappedStart = existing.has(start);
      return { created: [start], completed: false };
    }
    const axisA = this.#anchors[0]!;
    const existing = new Set(this.sketch.geometry.map((e) => e.id));
    const axisB = this.#placePoint(at);
    const snappedEnd = existing.has(axisB);
    if (axisB === axisA) return { created: [], completed: false };
    const a = this.#positionOf(axisA)!, b = this.#positionOf(axisB)!;
    const radius = Math.hypot(b.x - a.x, b.y - a.y) / 2;
    if (radius < 1e-6) return { created: [], completed: false };
    const centreAt = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const centre = this.sketch.addPoint(centreAt.x, centreAt.y);
    // A click ON an existing point means "the arc ends HERE": that point IS the arc's
    // end, one point, not two stacked. Changing the sweep then moves the centre along
    // the bisector to keep such an end where it is. A fresh click gets its own end
    // point, sitting on the axis end to begin with, so the centre holds and the end
    // travels round the circle instead.
    const start = this.#arcSnappedStart ? axisA : this.sketch.addPoint(a.x, a.y);
    const end = snappedEnd ? axisB : this.sketch.addPoint(b.x, b.y);
    const startAngle = Math.atan2(a.y - centreAt.y, a.x - centreAt.x);
    const axis = this.sketch.addLine(axisA, axisB, true);
    const arc = this.sketch.addArc(centre, radius, start, end, startAngle, startAngle + Math.PI, axis);
    this.sketch.addLine(centre, axisA, true, arc);
    this.sketch.addLine(centre, axisB, true, arc);
    const sweep = this.sketch.addConstraint({ type: 'arcAngle', entity: arc, axis, value: 180 });
    this.#anchors = [];
    this.#arcSnappedStart = false;
    return { created: [axisA, axisB, centre, start, end, arc, axis, sweep], completed: true };
  }

  /** Whether the arc's first click landed on a point that already existed. */
  #arcSnappedStart = false;

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
