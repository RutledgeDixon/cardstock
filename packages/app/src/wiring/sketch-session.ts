import type { FeatureId, PlanePlacement, SolverPort, Vec2 } from '@cardstock/types';
import {
  ORIGIN_PLANES, type Document, type Sketch, SketchTools, type ToolKind,
} from '@cardstock/document';
import { Vector3 } from 'three';
import type { TopoRef } from '@cardstock/document';
import { SketchView, type Viewer } from '@cardstock/viewer';

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
   * A circle or arc dimensions immediately as a radius; a point waits for a second point
   * and becomes a distance. The value is seeded from the geometry as drawn, so placing a
   * dimension never moves anything — it just pins down what is already there.
   */
  placeDimension(): { placed: string | null; awaiting: boolean } {
    const id = this.pick();
    if (!id) return { placed: null, awaiting: this.#dimensionAnchor !== null };
    const entity = this.sketch.entity(id);
    if (!entity) return { placed: null, awaiting: false };

    if (entity.type === 'circle' || entity.type === 'arc') {
      const constraint = this.sketch.addConstraint({
        type: 'radius', entity: id, value: round(entity.radius),
      });
      this.#afterEdit();
      return { placed: constraint, awaiting: false };
    }

    if (entity.type !== 'point') return { placed: null, awaiting: false };

    if (this.#dimensionAnchor === null || this.#dimensionAnchor === id) {
      this.#dimensionAnchor = id;
      return { placed: null, awaiting: true };
    }

    const a = this.sketch.entity(this.#dimensionAnchor);
    const b = entity;
    if (a?.type !== 'point') { this.#dimensionAnchor = null; return { placed: null, awaiting: false }; }

    const constraint = this.sketch.addConstraint({
      type: 'distance', a: a.id, b: b.id,
      value: round(Math.hypot(b.x - a.x, b.y - a.y)),
    });
    this.#dimensionAnchor = null;
    this.#afterEdit();
    return { placed: constraint, awaiting: false };
  }

  /** Dimensions with where to draw their labels, in world space. */
  dimensions(): { id: string; text: string; expression: string; world: Vector3; error?: string }[] {
    const positionOf = (id: string) => {
      const entity = this.sketch.entity(id);
      return entity?.type === 'point' ? { x: entity.x, y: entity.y } : null;
    };

    const out: { id: string; text: string; expression: string; world: Vector3; error?: string }[] = [];
    for (const constraint of this.sketch.constraints) {
      const raw = (constraint as { value?: number | string }).value;
      if (raw === undefined) continue;
      const expression = String(raw);
      const error = this.sketch.expressionErrors.get(constraint.id);

      let anchor: { x: number; y: number } | null = null;
      let text = expression;

      if (constraint.type === 'distance') {
        const a = positionOf(constraint.a);
        const b = positionOf(constraint.b);
        if (a && b) {
          anchor = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          text = `${round(Math.hypot(b.x - a.x, b.y - a.y))}`;
        }
      } else if (constraint.type === 'radius' || constraint.type === 'diameter') {
        const entity = this.sketch.entity(constraint.entity);
        if (entity && (entity.type === 'circle' || entity.type === 'arc')) {
          const centre = positionOf(entity.centre);
          if (centre) {
            anchor = { x: centre.x + entity.radius * 0.7, y: centre.y + entity.radius * 0.7 };
            const measured = constraint.type === 'radius' ? entity.radius : entity.radius * 2;
            text = `${constraint.type === 'radius' ? 'R' : '⌀'}${round(measured)}`;
          }
        }
      }
      if (!anchor) continue;
      out.push({
        id: constraint.id, text, expression, world: this.view.toWorld(anchor),
        ...(error ? { error } : {}),
      });
    }
    return out;
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

    this.sketch.removeConstraint(constraintId);
    this.sketch.addConstraint({ ...existing, id: constraintId, value } as never);
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
    let best: { id: string; distance: number; isPoint: boolean } | null = null;
    const consider = (id: string, distance: number, isPoint = false) => {
      if (distance > tolerance) return;
      if (!best) { best = { id, distance, isPoint }; return; }
      if (best.isPoint !== isPoint) { if (isPoint) best = { id, distance, isPoint }; return; }
      if (distance < best.distance) best = { id, distance, isPoint };
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

  toggleSelection(id: string | null, additive: boolean): void {
    if (id === null) { if (!additive) this.selected.clear(); return; }
    if (additive) {
      if (this.selected.has(id)) this.selected.delete(id);
      else this.selected.add(id);
    } else {
      this.selected.clear();
      this.selected.add(id);
    }
  }

  /** @returns true when anything was removed. */
  deleteSelected(): boolean {
    if (this.selected.size === 0) return false;
    for (const id of this.selected) this.sketch.remove(id);
    this.selected.clear();
    this.refresh();
    this.doc?.markSketchChanged(this.featureId);
    return true;
  }

  /** Redraw from the current sketch state. */
  refresh(): void {
    this.view.update(this.sketch.geometry);
    this.view.setFullyConstrained(this.sketch.status === 'fully-constrained');
  }

  /** Where the cursor is, in sketch coordinates. */
  cursor(): { x: number; y: number } | null {
    return this.viewer.pointerOnPlane(this.placement);
  }

  /** Update the rubber-band feedback. Returns what is about to be inferred, if anything. */
  updatePreview(): string | null {
    const at = this.cursor();
    if (!at) { this.view.clearPreview(); return null; }
    const preview = this.tools.preview(at);
    this.view.setPreview(preview.segments, preview.circle);
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
