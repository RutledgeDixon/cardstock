import type { FeatureId, PlanePlacement, Vec2 } from '@cardstock/types';
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

    let best: { id: string; distance: number } | null = null;
    const consider = (id: string, distance: number) => {
      if (distance <= tolerance && (!best || distance < best.distance)) best = { id, distance };
    };

    const positionOf = (id: string) => {
      const entity = this.sketch.entity(id);
      return entity?.type === 'point' ? { x: entity.x, y: entity.y } : null;
    };

    for (const entity of this.sketch.geometry) {
      if (entity.type === 'point') {
        // Points win ties by being tested with a tighter radius: they sit ON the curves
        // that would otherwise always be equally close.
        consider(entity.id, Math.hypot(entity.x - at.x, entity.y - at.y) * 0.5);
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
