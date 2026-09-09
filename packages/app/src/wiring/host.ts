import { asFeatureId, type EntityRef, type FeatureId } from '@cardstock/types';
import type { Document, TopoRef } from '@cardstock/document';
import type { Viewer } from '@cardstock/viewer';
import { leafFeatures as bodyLeaves } from './model-bridge.js';
import type { CommandHost, CommandState } from '@cardstock/commands';

/**
 * The app's implementation of CommandHost.
 *
 * Commands describe intent; this decides how intent is carried out. Keeping it here
 * rather than inside @cardstock/commands is what lets commands stay dependency-free and
 * testable, and what stops the command layer reaching into the viewer.
 */
export interface HostDeps {
  doc: Document;
  viewer: Viewer;
  /** The feature whose output is currently on screen. */
  terminalFeature: () => FeatureId | null;
  /**
   * Mint durable references for picked edge indices.
   *
   * Lives here rather than on the viewer because it needs the kernel's fingerprints; the
   * viewer only knows tessellation indices, which are not a durable identity.
   */
  captureEdgeRefs: (feature: FeatureId, indices: readonly number[]) => Promise<TopoRef[]>;
  rebuild: () => Promise<void>;
  exportStl: () => Promise<void>;
  openPalette: () => void;
  openPanel: (id: FeatureId) => void;
  notify: (message: string, kind?: 'info' | 'error') => void;
  focused: () => FeatureId | null;
  setFocused: (id: FeatureId | null) => void;
  busy: () => boolean;

  // --- sketching
  beginSketch: (plane: 'xy' | 'xz' | 'yz') => Promise<void>;
  beginSketchOnFace: () => Promise<boolean>;
  editSketch: () => Promise<boolean>;
  deleteSketchSelection: () => boolean;
  finishSketch: () => Promise<void>;
  setSketchTool: (tool: 'select' | 'line' | 'rectangle' | 'circle' | 'dimension') => void;
  sketching: () => boolean;
  sketchTool: () => 'select' | 'line' | 'rectangle' | 'circle' | 'dimension' | null;
}

export function createHost(deps: HostDeps): CommandHost {
  const { doc, viewer } = deps;

  /** A fresh id and a name that is unique enough to read in the tree. */
  const nameFor = (type: string) => {
    const existing = doc.features.filter((f) => f.type === type).length;
    const label = type[0]!.toUpperCase() + type.slice(1);
    return existing === 0 ? label : `${label} ${existing + 1}`;
  };

  /** Just clear of everything on screen, so a new shape lands beside the model. */
  const nextFreeX = (): number => {
    let maxX = -Infinity;
    for (const body of viewer.bodies.values()) maxX = Math.max(maxX, body.data.bounds.max.x);
    return Number.isFinite(maxX) ? Math.ceil((maxX + 15) / 5) * 5 : 0;
  };

  /** Bodies nothing else consumes — the things a boolean can combine. */
  const leafFeatures = (): FeatureId[] => bodyLeaves(doc);

  return {
    state: (): CommandState => ({
      selectionKind: viewer.selection.selected[0]?.kind ?? null,
      selectionCount: viewer.selection.selected.length,
      hoverKind: viewer.selection.hover?.kind ?? null,
      hasModel: viewer.bodies.size > 0,
      featureCount: doc.features.length,
      bodyCount: leafFeatures().length,
      canUndo: doc.canUndo,
      canRedo: doc.canRedo,
      busy: deps.busy(),
      focusedFeature: deps.focused(),
      sketching: deps.sketching(),
      sketchTool: deps.sketchTool(),
    }),

    selection: (): readonly EntityRef[] => viewer.selection.selected,
    clearSelection: () => viewer.selection.clear(),

    async addPrimitive(type) {
      const id = doc.newFeatureId(type);
      // Sensible starting dimensions: big enough to see, round enough to edit.
      const size = type === 'box'
        ? { dx: '40', dy: '30', dz: '20' }
        : type === 'cylinder'
          ? { radius: '10', height: '30' }
          : { radius: '15' };

      // Place it BESIDE what already exists rather than on top of it. Two shapes at the
      // origin overlap into one ambiguous blob, and the usual next step is to combine
      // them, which needs them positioned relative to each other anyway.
      const x = nextFreeX();
      const values = { ...size, x: String(x), y: '0', z: '0' };

      doc.addFeature({ id, type, name: nameFor(type), values, inputs: {} });
      deps.setFocused(id);
      await deps.rebuild();
      // Frame it: a new shape you cannot see reads as nothing having happened.
      viewer.fitAll();
      deps.openPanel(id);
      return id;
    },

    async addEdgeOperation(type) {
      const edges = viewer.selection.selected.filter((r) => r.kind === 'edge');
      if (edges.length === 0) {
        deps.notify('Select one or more edges first', 'error');
        return null;
      }
      const source = deps.terminalFeature();
      if (!source) {
        deps.notify('Nothing to modify', 'error');
        return null;
      }
      const refs = await deps.captureEdgeRefs(source, edges.map((e) => e.index));
      if (refs.length === 0) {
        deps.notify('Could not identify those edges', 'error');
        return null;
      }
      const id = doc.newFeatureId(type);
      doc.addFeature({
        id, type, name: nameFor(type),
        values: type === 'fillet' ? { radius: '3' } : { distance: '2' },
        inputs: { base: source },
        selections: { edges: refs },
      });
      viewer.selection.clear();
      deps.setFocused(id);
      await deps.rebuild();
      deps.openPanel(id);
      return id;
    },

    async addBoolean(op) {
      const leaves = leafFeatures();
      if (leaves.length < 2) {
        deps.notify('Needs two separate bodies to combine', 'error');
        return null;
      }
      // The two most recent leaves: base first, tool second, matching what the user
      // just built.
      const tool = leaves.at(-1)!;
      const base = leaves.at(-2)!;
      const id = doc.newFeatureId(op);
      doc.addFeature({ id, type: op, name: nameFor(op), values: {}, inputs: { base, tool } });
      deps.setFocused(id);
      await deps.rebuild();
      return id;
    },

    async addMove() {
      const source = deps.terminalFeature();
      if (!source) { deps.notify('Nothing to move', 'error'); return null; }
      const id = doc.newFeatureId('move');
      doc.addFeature({
        id, type: 'move', name: nameFor('move'),
        values: { dx: '0', dy: '0', dz: '0' }, inputs: { base: source },
      });
      deps.setFocused(id);
      await deps.rebuild();
      deps.openPanel(id);
      return id;
    },

    async deleteFocused() {
      const id = deps.focused();
      if (!id) return false;
      const removed = doc.removeFeature(id);
      if (removed) { deps.setFocused(null); await deps.rebuild(); }
      return removed;
    },

    async suppressFocused(suppressed) {
      const id = deps.focused();
      if (!id) return false;
      const changed = doc.setSuppressed(id, suppressed);
      if (changed) await deps.rebuild();
      return changed;
    },

    async undo() { if (doc.undo()) await deps.rebuild(); },
    async redo() { if (doc.redo()) await deps.rebuild(); },

    fitAll: () => viewer.fitAll(),
    setNamedView: (view) => viewer.controller.setView(view),
    lookAtSelection: () => viewer.lookAtHoveredFace(),
    pivotToSelection: () => viewer.pivotToPointer(),
    cycleSelectionFilter: (direction) => viewer.selection.cycleFilter(direction),

    beginSketch: (plane) => deps.beginSketch(plane),
    beginSketchOnFace: () => deps.beginSketchOnFace(),
    editSketch: () => deps.editSketch(),
    deleteSketchSelection: () => deps.deleteSketchSelection(),
    finishSketch: () => deps.finishSketch(),
    setSketchTool: (tool) => deps.setSketchTool(tool),

    async extrudeSketch() {
      // The most recent sketch is the one just drawn, which is what "extrude" means
      // immediately after finishing one.
      const sketchFeature = [...doc.features].reverse().find((f) => f.type === 'sketch');
      if (!sketchFeature) { deps.notify('Draw a sketch first', 'error'); return null; }
      const id = doc.newFeatureId('extrude');
      doc.addFeature({
        id, type: 'extrude', name: nameFor('extrude'),
        values: { distance: '10' }, inputs: { profile: sketchFeature.id },
      });
      deps.setFocused(id);
      await deps.rebuild();
      viewer.fitAll();
      deps.openPanel(id);
      return id;
    },

    exportStl: () => deps.exportStl(),
    openPalette: () => deps.openPalette(),
    openPanel: (id) => deps.openPanel(id),
    notify: (message, kind) => deps.notify(message, kind),
  };
}

export { asFeatureId };
