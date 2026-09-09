import type { EntityRef, FeatureId } from '@cardstock/types';
import type { CommandState } from './command.js';

/**
 * What commands are allowed to do.
 *
 * Commands cannot reach the viewer or the kernel directly — `@cardstock/commands` may
 * import only types and the document — so the app supplies this. That keeps commands
 * describing *intent* while the app decides how intent is carried out, and it means the
 * whole command set is testable against a stub.
 */
export interface CommandHost {
  state(): CommandState;

  /** Currently selected entities, in pick order. */
  selection(): readonly EntityRef[];
  clearSelection(): void;

  // --- model
  /** Add a primitive at the origin and select it. Returns the new feature. */
  addPrimitive(type: 'box' | 'cylinder' | 'sphere'): Promise<FeatureId>;
  /** Apply an edge operation to the current edge selection. */
  addEdgeOperation(type: 'fillet' | 'chamfer'): Promise<FeatureId | null>;
  /**
   * Add a feature of the given type onto the current body.
   *
   * One entry point rather than a method per feature, so adding a feature is a matter of
   * registering a command and a definition — not of threading another method through the
   * host, the app and the interface.
   */
  addSolidFeature(type: string): Promise<FeatureId | null>;
  /** Combine the two most recent bodies. */
  addBoolean(op: 'union' | 'cut' | 'intersect'): Promise<FeatureId | null>;
  addMove(): Promise<FeatureId | null>;
  deleteFocused(): Promise<boolean>;
  suppressFocused(suppressed: boolean): Promise<boolean>;

  undo(): Promise<void>;
  redo(): Promise<void>;

  // --- view
  fitAll(): void;
  setNamedView(view: 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso'): void;
  lookAtSelection(): boolean;
  pivotToSelection(): boolean;
  cycleSelectionFilter(direction: 1 | -1): void;

  // --- sketching
  /** Open a new sketch on an origin plane and enter sketch mode. */
  beginSketch(plane: 'xy' | 'xz' | 'yz'): Promise<void>;
  /** Open a sketch on the selected planar face. */
  beginSketchOnFace(): Promise<boolean>;
  /** Reopen the focused sketch for editing. */
  editSketch(): Promise<boolean>;
  /** Delete whatever is selected inside the open sketch. */
  deleteSketchSelection(): boolean;
  /**
   * Apply a geometric constraint to the current sketch selection.
   *
   * @returns null when applied, or the reason it could not — which the caller shows,
   *          because "Perpendicular is disabled" teaches nothing on its own.
   */
  applySketchConstraint(type: string): string | null;
  /** Why this constraint cannot be applied right now, or null when it can. */
  sketchConstraintBlocker(type: string): string | null;
  /** Leave sketch mode, rebuilding whatever the sketch feeds. */
  finishSketch(): Promise<void>;
  setSketchTool(tool: 'select' | 'line' | 'rectangle' | 'circle' | 'dimension'): void;
  /** Extrude the sketch that was just finished. */
  extrudeSketch(): Promise<FeatureId | null>;

  // --- output
  exportStl(): Promise<void>;

  // --- ui affordances the command layer may ask for
  openPalette(): void;
  /** Show the about dialog: what the name means, and which build this is. */
  openAbout(): void;
  openPanel(feature: FeatureId): void;
  notify(message: string, kind?: 'info' | 'error'): void;
}
