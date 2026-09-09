import type { FeatureId, PlanePlacement } from '@cardstock/types';
import {
  ORIGIN_PLANES, type Document, type Sketch, SketchTools, type ToolKind,
} from '@cardstock/document';
import { Vector3 } from 'three';
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
