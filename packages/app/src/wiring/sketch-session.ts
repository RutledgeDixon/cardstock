import type { FeatureId, PlanePlacement, SketchGeometry, SolverPort, Vec2 } from '@cardstock/types';
import {
  ORIGIN_PLANES, type Document, type Sketch, SketchTools, type ToolKind,
} from '@cardstock/document';
import { Vector3 } from 'three';
import type { TopoRef } from '@cardstock/document';
import { SketchView, type Viewer } from '@cardstock/viewer';
import * as draw from './dimension-lines.js';

/**
 * An open sketch: the model, the tools, and what is drawn on screen.
 *
 * Bundled together because they are only ever meaningful at once, and because leaving
 * one behind — a SketchView still in the scene after the sketch closed — is the obvious
 * way to end up with a ghost drawing floating over the model.
 */
export class SketchSession {
  readonly tools: SketchTools;
  readonly view: SketchView;

  constructor(
    readonly featureId: FeatureId,
    readonly sketch: Sketch,
    readonly placement: PlanePlacement,
    private readonly viewer: Viewer,
    private readonly doc?: Document,
  ) {
    this.tools = new SketchTools(sketch);
    this.view = new SketchView(placement);
    // Fat lines are screen-space quads, so their width means nothing until the material
    // knows the canvas size.
    this.view.setResolution(viewer.viewport.width, viewer.viewport.height);
    this.viewer.scene.add(this.view.group);
    this.refresh();
  }

  static open(
    doc: Document, viewer: Viewer, plane: 'xy' | 'xz' | 'yz',
  ): SketchSession {
    const { sketch, id } = doc.addSketch({ kind: 'origin', plane });
    return new SketchSession(id, sketch, ORIGIN_PLANES[plane], viewer, doc);
  }

  static onFace(
    doc: Document, viewer: Viewer, ref: TopoRef, placement: PlanePlacement, base: FeatureId,
  ): SketchSession {
    const { sketch, id } = doc.addSketch({ kind: 'face', ref }, { base });
    return new SketchSession(id, sketch, placement, viewer, doc);
  }

  /** Reopen an existing sketch for editing. */
  static reopen(
    doc: Document, viewer: Viewer, featureId: FeatureId, placement: PlanePlacement,
  ): SketchSession | null {
    const sketch = doc.sketchFor(featureId);
    return sketch ? new SketchSession(featureId, sketch, placement, viewer, doc) : null;
  }

  // ------------------------------------------------------------------ dimensions
  /** First entity of a two-part dimension, waiting for its partner. */
  #dimensionAnchor: string | null = null;

  get awaitingDimensionPartner(): boolean { return this.#dimensionAnchor !== null; }

  /**
   * Place a dimension on whatever is under the cursor.
   *
   * Two picks make a dimension, and the pair decides its kind: two points are a
   * distance, a point and a line the gap between them, two parallel lines their
   * spacing (two others, the angle), a circle and a line or point the distance from
   * the rim. A circle picked twice — or once, then empty space — is its radius.
   *
   * A new dimension is a REFERENCE: it shows the value as drawn and pins nothing, so
   * placing one never moves the sketch or takes a freedom away. Typing into it makes
   * it drive.
   */
  placeDimension(): { placed: string | null; awaiting: boolean } {
    const id = this.pick();
    const anchor = this.#dimensionAnchor;

    if (!id) {
      // Empty space after a circle: that circle's radius.
      const circle = anchor ? this.sketch.entity(anchor) : null;
      if (circle && (circle.type === 'circle' || circle.type === 'arc')) {
        this.#dimensionAnchor = null;
        return { placed: this.#addDimension({ type: 'radius', entity: circle.id, value: round(circle.radius) }), awaiting: false };
      }
      return { placed: null, awaiting: anchor !== null };
    }
    const entity = this.sketch.entity(id);
    if (!entity) return { placed: null, awaiting: false };

    if (anchor === null) {
      this.#dimensionAnchor = id;
      // Show what was picked, as every other tool does; the second pick completes it.
      this.selected.clear();
      this.selected.add(id);
      this.view.setSelection(this.selected);
      return { placed: null, awaiting: true };
    }
    const first = this.sketch.entity(anchor);
    this.#dimensionAnchor = null;
    this.selected.clear();
    this.view.setSelection(this.selected);
    if (!first) return { placed: null, awaiting: false };

    const placed = this.#dimensionBetween(first, entity);
    return { placed, awaiting: false };
  }

  /**
   * A dimension for whatever is selected — from the constrain ring, where the user
   * has already said what to measure. One circle is its radius; two entities are the
   * dimension the pair makes. Returns why, when nothing can be made of it.
   */
  dimensionSelection(): { placed: string | null; reason: string | null } {
    const reason = this.dimensionBlocker();
    if (reason) return { placed: null, reason };
    const ids = [...this.selected];
    const a = this.sketch.entity(ids[0]!)!;
    const b = ids.length === 2 ? this.sketch.entity(ids[1]!)! : a;
    const placed = this.#dimensionBetween(a, b);
    this.selected.clear();
    this.view.setSelection(this.selected);
    return placed
      ? { placed, reason: null }
      : { placed: null, reason: 'Those two cannot be dimensioned against each other' };
  }

  /** Why the selection cannot be dimensioned, or null when it can. */
  dimensionBlocker(): string | null {
    const ids = [...this.selected];
    const kinds = ids.map((id) => this.sketch.entity(id)?.type);
    if (ids.length === 1) {
      return kinds[0] === 'circle' || kinds[0] === 'arc' ? null : 'Select a circle, or two things to measure between';
    }
    if (ids.length !== 2) return 'Select two things to measure between';
    if (kinds.some((k) => k === undefined)) return 'Select two things to measure between';
    if (kinds.some((k) => k === 'arc')) return 'An arc is dimensioned by its radius and sweep; pick it alone';
    const [a, b] = ids.map((id) => this.sketch.entity(id)!);
    const endOf = (point: SketchGeometry, line: SketchGeometry) =>
      point.type === 'point' && line.type === 'line' && (line.p1 === point.id || line.p2 === point.id);
    if (endOf(a!, b!) || endOf(b!, a!)) return 'That point is already an end of that line';
    return null;
  }

  #addDimension(constraint: Parameters<Sketch['addConstraint']>[0]): string {
    const id = this.sketch.addConstraint({ ...constraint, reference: true } as never);
    this.#afterEdit();
    return id;
  }

  /** The dimension a pair of entities makes, or null when the pair means nothing. */
  #dimensionBetween(first: SketchGeometry, second: SketchGeometry): string | null {
    const isCircle = (e: SketchGeometry) => e.type === 'circle' || e.type === 'arc';
    const positionOf = (pid: string) => {
      const e = this.sketch.entity(pid);
      return e?.type === 'point' ? { x: e.x, y: e.y } : null;
    };
    const lineOf = (e: SketchGeometry) => {
      if (e.type !== 'line') return null;
      const a = positionOf(e.p1), b = positionOf(e.p2);
      return a && b ? { a, b } : null;
    };
    const centreOf = (e: SketchGeometry) => (isCircle(e) ? positionOf((e as { centre: string }).centre) : null);

    if (first.id === second.id) {
      if (isCircle(first)) {
        return this.#addDimension({ type: 'radius', entity: first.id, value: round((first as { radius: number }).radius) });
      }
      return null;
    }

    // Order the pair so each case is written once.
    const rank = (e: SketchGeometry) => (e.type === 'point' ? 0 : e.type === 'line' ? 1 : 2);
    const [p, q] = rank(first) <= rank(second) ? [first, second] : [second, first];

    if (p.type === 'point' && q.type === 'point') {
      return this.#addDimension({ type: 'distance', a: p.id, b: q.id, value: round(distance2(p, q)) });
    }
    if (p.type === 'point' && q.type === 'line') {
      // An endpoint is zero from its own line; the distance would be meaningless.
      if (q.p1 === p.id || q.p2 === p.id) return null;
      const line = lineOf(q);
      if (!line) return null;
      return this.#addDimension({
        type: 'pointLineDistance', point: p.id, line: q.id, value: round(pointToLine(p, line.a, line.b)),
      });
    }
    if (p.type === 'line' && q.type === 'line') {
      const la = lineOf(p), lb = lineOf(q);
      if (!la || !lb) return null;
      if (areParallel(la, lb)) {
        // Parallel lines: their spacing. Parallelism is pinned alongside so the
        // dimension keeps meaning something if the value is later driven.
        if (!this.sketch.constraints.some((c) => c.type === 'parallel'
          && ((c.a === p.id && c.b === q.id) || (c.a === q.id && c.b === p.id)))) {
          this.sketch.addConstraint({ type: 'parallel', a: p.id, b: q.id });
        }
        return this.#addDimension({
          type: 'lineLineDistance', a: p.id, b: q.id, value: round(pointToLine(la.a, lb.a, lb.b)),
        });
      }
      return this.#addDimension({
        type: 'angle', a: p.id, b: q.id, value: round(angleBetween(la, lb)),
      });
    }
    if (p.type === 'point' && isCircle(q)) {
      const centre = centreOf(q);
      if (!centre) return null;
      const gap = Math.abs(distance2(p, centre) - (q as { radius: number }).radius);
      return this.#addDimension({ type: 'pointCircleDistance', point: p.id, circle: q.id, value: round(gap) });
    }
    if (p.type === 'line' && isCircle(q)) {
      const line = lineOf(p), centre = centreOf(q);
      if (!line || !centre) return null;
      const gap = Math.abs(pointToLine(centre, line.a, line.b) - (q as { radius: number }).radius);
      return this.#addDimension({ type: 'circleLineDistance', circle: q.id, line: p.id, value: round(gap) });
    }
    return null;
  }

  /**
   * Every dimension, with its measured text, where its value sits, and the lines that
   * go with it.
   *
   * A distance between two points that a sketch line already joins needs no lines of
   * its own — the value sits on the line. Everything else is drawn as an engineering
   * drawing would: extension lines, a dimension line with arrowheads, a leader for a
   * radius, an arc for an angle. The lines are pushed to the view here, so they are
   * current whenever the labels are.
   */
  dimensions(): { id: string; text: string; expression: string; world: Vector3; reference: boolean; error?: string }[] {
    const positionOf = (id: string) => {
      const entity = this.sketch.entity(id);
      return entity?.type === 'point' ? { x: entity.x, y: entity.y } : null;
    };
    const lineOf = (id: string) => {
      const e = this.sketch.entity(id);
      if (e?.type !== 'line') return null;
      const a = positionOf(e.p1), b = positionOf(e.p2);
      return a && b ? { a, b } : null;
    };
    const circleOf = (id: string) => {
      const e = this.sketch.entity(id);
      if (!e || (e.type !== 'circle' && e.type !== 'arc')) return null;
      const centre = positionOf(e.centre);
      return centre ? { centre, radius: e.radius } : null;
    };
    const joined = (a: string, b: string) => this.sketch.geometry.some((e) =>
      e.type === 'line' && ((e.p1 === a && e.p2 === b) || (e.p1 === b && e.p2 === a)));
    const mid = (a: Vec2, b: Vec2) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    // The sketch's centre, so linear dimensions offset outward rather than across it.
    const points = this.sketch.geometry.filter((e): e is Extract<SketchGeometry, { type: 'point' }> => e.type === 'point');
    const centre = points.length > 0
      ? { x: points.reduce((n, p) => n + p.x, 0) / points.length, y: points.reduce((n, p) => n + p.y, 0) / points.length }
      : { x: 0, y: 0 };
    const upp = this.unitsPerPixel();

    const out: { id: string; text: string; expression: string; world: Vector3; reference: boolean; error?: string }[] = [];
    const segments: draw.Segment[] = [];
    for (const constraint of this.sketch.constraints) {
      const raw = (constraint as { value?: number | string }).value;
      if (raw === undefined) continue;
      const expression = String(raw);
      const reference = (constraint as { reference?: boolean }).reference === true;
      const error = this.sketch.expressionErrors.get(constraint.id);

      let drawing: draw.DimensionDrawing | null = null;
      let text = expression;
      const c = constraint as never as Record<string, string>;

      switch (constraint.type) {
        case 'distance': {
          const a = positionOf(c.a!), b = positionOf(c.b!);
          if (a && b) {
            text = `${round(distance2(a, b))}`;
            drawing = joined(c.a!, c.b!)
              ? { segments: [], anchor: mid(a, b) }
              : draw.pointToPoint(a, b, centre, upp);
          }
          break;
        }
        case 'pointLineDistance': {
          const p = positionOf(c.point!), l = lineOf(c.line!);
          if (p && l) { text = `${round(pointToLine(p, l.a, l.b))}`; drawing = draw.pointToLine(p, l.a, l.b, upp); }
          break;
        }
        case 'lineLineDistance': {
          const la = lineOf(c.a!), lb = lineOf(c.b!);
          if (la && lb) { text = `${round(pointToLine(la.a, lb.a, lb.b))}`; drawing = draw.lineToLine(la, lb, upp); }
          break;
        }
        case 'angle': {
          const la = lineOf(c.a!), lb = lineOf(c.b!);
          if (la && lb) { text = `${round(angleBetween(la, lb))}°`; drawing = draw.angle(la, lb, upp); }
          break;
        }
        case 'pointCircleDistance': {
          const p = positionOf(c.point!), k = circleOf(c.circle!);
          if (p && k) {
            text = `${round(Math.abs(distance2(p, k.centre) - k.radius))}`;
            drawing = draw.pointToCircle(p, k.centre, k.radius, upp);
          }
          break;
        }
        case 'circleLineDistance': {
          const k = circleOf(c.circle!), l = lineOf(c.line!);
          if (k && l) {
            text = `${round(Math.abs(pointToLine(k.centre, l.a, l.b) - k.radius))}`;
            drawing = draw.circleToLine(k.centre, k.radius, l.a, l.b, upp);
          }
          break;
        }
        case 'radius':
        case 'diameter': {
          const k = circleOf(c.entity!);
          if (k) {
            const measured = constraint.type === 'radius' ? k.radius : k.radius * 2;
            text = `${constraint.type === 'radius' ? 'R' : '⌀'}${round(measured)}`;
            const entity = this.sketch.entity(c.entity!);
            const through = entity?.type === 'arc'
              ? entity.startAngle + arcSweepOf(entity) / 2
              : Math.PI / 4;
            drawing = constraint.type === 'radius'
              ? draw.radius(k.centre, k.radius, upp, through)
              : draw.diameter(k.centre, k.radius, upp);
          }
          break;
        }
        case 'arcAngle': {
          const arc = this.sketch.entity(c.entity!);
          if (arc?.type === 'arc') {
            const centre = positionOf(arc.centre);
            const axis = lineOf(c.axis!);
            if (centre) {
              const sweep = arcSweepOf(arc);
              // Which side of the axis: the arc's middle against the axis direction.
              let side = 1;
              if (axis) {
                const midAngle = arc.startAngle + sweep / 2;
                const m = { x: centre.x + arc.radius * Math.cos(midAngle) - axis.a.x, y: centre.y + arc.radius * Math.sin(midAngle) - axis.a.y };
                const d = { x: axis.b.x - axis.a.x, y: axis.b.y - axis.a.y };
                // Positive is the side a counter-clockwise arc from the axis start lands
                // on: to the right of a→b, where the cross product is negative.
                side = d.x * m.y - d.y * m.x < 0 ? 1 : -1;
              }
              text = `${round((side * sweep * 180) / Math.PI)}°`;
              drawing = draw.arcSweep(centre, arc.radius, arc.startAngle, sweep, upp);
            }
          }
          break;
        }
        default:
          break;
      }
      if (!drawing) continue;
      segments.push(...drawing.segments);
      out.push({
        id: constraint.id, text, expression, world: this.view.toWorld(drawing.anchor), reference,
        ...(error ? { error } : {}),
      });
    }
    this.view.setDimensionLines(segments);
    return out;
  }

  /** How big a pixel is in sketch units, at the current zoom. */
  unitsPerPixel(): number {
    const height = Math.max(1, this.viewer.viewport.height);
    // An orthographic camera's zoom is its half-height in world units; two of those span
    // the viewport.
    return (this.viewer.controller.target.zoom * 2) / height;
  }

  /** @returns an error message, or null. */
  setDimension(constraintId: string, expression: string): string | null {
    const existing = this.sketch.constraint(constraintId);
    if (!existing) return 'that dimension no longer exists';
    const trimmed = expression.trim();
    if (trimmed === '') return 'a dimension needs a value';

    // Keep it as typed: a literal stays a number, anything else stays an expression so
    // it keeps following whatever it references.
    const asNumber = Number(trimmed);
    const value = Number.isFinite(asNumber) ? asNumber : trimmed;

    // Typing a value is what makes a dimension drive: the reference flag comes off.
    this.sketch.removeConstraint(constraintId);
    const driving = { ...existing, id: constraintId, value } as unknown as { reference?: boolean };
    delete driving.reference;
    this.sketch.addConstraint(driving as never);
    this.#afterEdit();
    return null;
  }

  // ------------------------------------------------------------------ dragging
  #dragging: string | null = null;

  /** Begin dragging the point under the cursor, if there is one. */
  beginDrag(): boolean {
    const id = this.pick();
    const entity = id ? this.sketch.entity(id) : null;
    if (entity?.type !== 'point' || entity.fixed) return false;
    this.#dragging = entity.id;
    return true;
  }

  get isDragging(): boolean { return this.#dragging !== null; }

  /**
   * Pull the dragged point toward the cursor and re-solve.
   *
   * The solver decides where it actually lands: constraints still win, so dragging a
   * fully constrained sketch simply does nothing rather than breaking it.
   */
  async updateDrag(solver: SolverPort, parameters: Record<string, number>): Promise<boolean> {
    const at = this.cursor();
    if (!this.#dragging || !at) return false;
    await this.sketch.solve(solver, parameters, { point: this.#dragging, x: at.x, y: at.y });
    this.refresh();
    return true;
  }

  endDrag(): boolean {
    if (!this.#dragging) return false;
    this.#dragging = null;
    this.doc?.markSketchChanged(this.featureId);
    return true;
  }

  #afterEdit(): void {
    this.refresh();
    this.doc?.markSketchChanged(this.featureId);
  }

  // ------------------------------------------------------------------ selection
  readonly selected = new Set<string>();

  /**
   * The entity nearest the cursor, within a tolerance that scales with zoom.
   *
   * A fixed millimetre tolerance would be unusable at both ends: unreachable zoomed out,
   * and grabbing half the sketch zoomed in.
   */
  pick(): string | null {
    const at = this.cursor();
    if (!at) return null;
    const tolerance = this.viewer.controller.current.zoom * 0.02;

    // Points beat curves outright, not by a distance fudge. At a corner the point and
    // both its lines are all exactly zero away, so a pure distance comparison hands the
    // pick to whichever the loop happened to reach first — and that corner point could
    // then never be grabbed at all.
    let best: { id: string; distance: number; isPoint: boolean; external: boolean } | null = null;
    const consider = (id: string, distance: number, isPoint = false) => {
      if (distance > tolerance) return;
      const external = !!this.sketch.entity(id)?.external;
      const candidate = { id, distance, isPoint, external };
      if (!best) { best = candidate; return; }
      if (best.isPoint !== isPoint) { if (isPoint) best = candidate; return; }
      // Where an arc's end sits on its axis end, the arc's end is the one meant: it is
      // what a line drawn from there should follow when the sweep changes.
      if (isPoint && Math.abs(distance - best.distance) < 1e-9) {
        if (this.#isArcEnd(id) && !this.#isArcEnd(best.id)) best = candidate;
        return;
      }
      // The sketch's own geometry beats reference geometry lying on top of it: a line
      // drawn along an origin axis must still be pickable as itself.
      if (Math.abs(distance - best.distance) < 1e-9) {
        if (best.external && !external) best = candidate;
        return;
      }
      if (distance < best.distance) best = candidate;
    };

    const positionOf = (id: string) => {
      const entity = this.sketch.entity(id);
      return entity?.type === 'point' ? { x: entity.x, y: entity.y } : null;
    };

    for (const entity of this.sketch.geometry) {
      if (entity.type === 'point') {
        consider(entity.id, Math.hypot(entity.x - at.x, entity.y - at.y), true);
      } else if (entity.type === 'line') {
        const a = positionOf(entity.p1);
        const b = positionOf(entity.p2);
        if (a && b) consider(entity.id, distanceToSegment(at, a, b));
      } else {
        const centre = positionOf(entity.centre);
        if (centre) {
          consider(entity.id,
            Math.abs(Math.hypot(at.x - centre.x, at.y - centre.y) - entity.radius));
        }
      }
    }
    return best ? (best as { id: string }).id : null;
  }

  #isArcEnd(id: string): boolean {
    return this.sketch.geometry.some((e) => e.type === 'arc' && (e.start === id || e.end === id));
  }

  toggleSelection(id: string | null, additive: boolean): void {
    if (id === null) {
      if (!additive) this.selected.clear();
    } else if (additive) {
      if (this.selected.has(id)) this.selected.delete(id);
      else this.selected.add(id);
    } else {
      this.selected.clear();
      this.selected.add(id);
    }
    // Push it to the view here rather than leaving each caller to remember: a selection
    // that changes without redrawing is a selection the user cannot see, which is what
    // sketch selection did — it registered, and looked like nothing had happened.
    this.view.setSelection(this.selected);
  }

  /** @returns true when anything was removed. */
  deleteSelected(): boolean {
    if (this.selected.size === 0) return false;
    // Reference geometry belongs to the face or the origin, not to the sketch.
    for (const id of this.selected) if (!this.sketch.entity(id)?.external) this.sketch.remove(id);
    this.selected.clear();
    this.refresh();
    this.doc?.markSketchChanged(this.featureId);
    return true;
  }

  /** Redraw from the current sketch state. */
  refresh(): void {
    // Resolution is re-applied here rather than only at construction: the window can be
    // resized mid-sketch, and a stale resolution makes every line the wrong width.
    this.view.setResolution(this.viewer.viewport.width, this.viewer.viewport.height);
    this.view.update(this.sketch.geometry);
    this.view.setSelection(this.selected);
    this.view.setSnapTarget(null);
    this.view.setFullyConstrained(this.sketch.status === 'fully-constrained');
  }

  /** Where the cursor is, in sketch coordinates. */
  cursor(): { x: number; y: number } | null {
    this.#retune();
    return this.viewer.pointerOnPlane(this.placement);
  }

  /**
   * Tell the tools how big a pixel is, in sketch units.
   *
   * Done on every cursor read rather than once, because the user zooms while drawing and
   * a stale scale silently changes how forgiving snapping is.
   */
  #retune(): void {
    this.tools.setScale(this.unitsPerPixel());
  }

  /** Update the rubber-band feedback. Returns what is about to be inferred, if anything. */
  updatePreview(): string | null {
    const at = this.cursor();
    if (!at) {
      this.view.clearPreview();
      this.view.setSnapTarget(null);
      return null;
    }
    const preview = this.tools.preview(at);
    this.view.setPreview(preview.segments, preview.circle, preview.arc);

    // Show WHERE the click would land when it would join an existing vertex. The tools
    // have always reported this and nothing drew it, so connecting to a point and
    // missing it looked exactly the same — and connecting created no new geometry, which
    // read as the click doing nothing.
    const snap = preview.snapPoint ? this.sketch.entity(preview.snapPoint) : null;
    this.view.setSnapTarget(snap?.type === 'point' ? { x: snap.x, y: snap.y } : null);
    return preview.inference;
  }

  setTool(tool: ToolKind): void {
    this.tools.setTool(tool);
    this.view.clearPreview();
    this.refresh();
  }

  /** @returns true when something was created. */
  click(): boolean {
    const at = this.cursor();
    if (!at) return false;
    const result = this.tools.click(at);
    this.refresh();
    if (result.created.length > 0) {
      // The tools mutate the Sketch directly, so the graph has to be told.
      this.doc?.markSketchChanged(this.featureId);
    }
    return result.created.length > 0;
  }

  /** Look square at the sketch plane, which is how sketching should always start. */
  alignCamera(): void {
    const { normal } = this.placement;
    this.viewer.controller.faceView(new Vector3(normal.x, normal.y, normal.z));
  }

  close(): void {
    this.tools.cancel();
    this.doc?.markSketchChanged(this.featureId);
    this.viewer.scene.remove(this.view.group);
    this.view.dispose();
  }
}

/** Perpendicular distance from a point to a segment, in sketch units. */
function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0
    : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
  return Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y);
}

/** Dimensions are shown to a tenth of a millimetre; more digits are noise on a label. */
const round = (value: number): number => Math.round(value * 10) / 10;
/** An arc's sweep in (0, 2π], counter-clockwise from its start. */
const arcSweepOf = (arc: { startAngle: number; endAngle: number }) => {
  let sweep = arc.endAngle - arc.startAngle;
  while (sweep <= 0) sweep += Math.PI * 2;
  return sweep;
};
const distance2 = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
/** Perpendicular distance from a point to the infinite line through a and b. */
const pointToLine = (p: Vec2, a: Vec2, b: Vec2) => {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return Math.abs(dx * (a.y - p.y) - dy * (a.x - p.x)) / len;
};
const areParallel = (l: { a: Vec2; b: Vec2 }, m: { a: Vec2; b: Vec2 }) => {
  const ux = l.b.x - l.a.x, uy = l.b.y - l.a.y, vx = m.b.x - m.a.x, vy = m.b.y - m.a.y;
  const cross = Math.abs(ux * vy - uy * vx);
  return cross <= 1e-3 * (Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1);
};
/** Acute angle between two lines, degrees. */
const angleBetween = (l: { a: Vec2; b: Vec2 }, m: { a: Vec2; b: Vec2 }) => {
  const a1 = Math.atan2(l.b.y - l.a.y, l.b.x - l.a.x);
  const a2 = Math.atan2(m.b.y - m.a.y, m.b.x - m.a.x);
  let d = Math.abs(a1 - a2) % Math.PI;
  if (d > Math.PI / 2) d = Math.PI - d;
  return (d * 180) / Math.PI;
};
