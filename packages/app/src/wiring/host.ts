import { asFeatureId, type EntityRef, type FeatureId } from '@cardstock/types';
import type { Document, TopoRef } from '@cardstock/document';
import type { Viewer } from '@cardstock/viewer';
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
}

export function createHost(deps: HostDeps): CommandHost {
  const { doc, viewer } = deps;

  /** A fresh id and a name that is unique enough to read in the tree. */
  const nameFor = (type: string) => {
    const existing = doc.features.filter((f) => f.type === type).length;
    const label = type[0]!.toUpperCase() + type.slice(1);
    return existing === 0 ? label : `${label} ${existing + 1}`;
  };

  /** Bodies nothing else consumes — the things a boolean can combine. */
  const leafFeatures = (): FeatureId[] => {
    const consumed = new Set<string>();
    for (const feature of doc.features) {
      for (const input of Object.values(feature.inputs)) consumed.add(input as string);
    }
    return doc.features.filter((f) => !consumed.has(f.id as string)).map((f) => f.id);
  };

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
    }),

    selection: (): readonly EntityRef[] => viewer.selection.selected,
    clearSelection: () => viewer.selection.clear(),

    async addPrimitive(type) {
      const id = doc.newFeatureId(type);
      // Sensible starting dimensions: big enough to see, round enough to edit.
      const values = type === 'box'
        ? { dx: '40', dy: '30', dz: '20' }
        : type === 'cylinder'
          ? { radius: '10', height: '30' }
          : { radius: '15' };
      doc.addFeature({ id, type, name: nameFor(type), values, inputs: {} });
      deps.setFocused(id);
      await deps.rebuild();
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

    exportStl: () => deps.exportStl(),
    openPalette: () => deps.openPalette(),
    openPanel: (id) => deps.openPanel(id),
    notify: (message, kind) => deps.notify(message, kind),
  };
}

export { asFeatureId };
