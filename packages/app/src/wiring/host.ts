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
  captureRefs: (
    feature: FeatureId,
    kind: 'face' | 'edge' | 'vertex',
    indices: readonly number[],
  ) => Promise<TopoRef[]>;
  rebuild: () => Promise<void>;
  exportStl: () => Promise<void>;
  openPalette: () => void;
  openAbout: () => void;
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
  sketchSelectionCount: () => number;
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

  /**
   * The feature a new operation should act on.
   *
   * The selection wins. A body id IS the id of the feature that produced it, so picking
   * a face on the second body and pressing Shell must shell THAT body — not whichever
   * feature happens to be last in the tree, which is what "the model is tied to the
   * first thing you drew" actually looks like from the inside.
   *
   * With nothing selected the terminal feature is right: it is what is on screen.
   */
  const targetFeature = (): { id: FeatureId | null; reason?: string } => {
    const selected = viewer.selection.selected;
    if (selected.length === 0) return { id: deps.terminalFeature() };

    const bodies = new Set(selected.map((ref) => ref.bodyId as unknown as FeatureId));
    if (bodies.size > 1) {
      return { id: null, reason: 'Select geometry on one body at a time' };
    }
    const [only] = bodies;
    // A selection can outlive the feature it came from — a rebuild that dropped a body
    // leaves stale refs — so fall back rather than addressing a feature that is gone.
    return { id: only && doc.feature(only) ? only : deps.terminalFeature() };
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
      sketching: deps.sketching(),
      sketchTool: deps.sketchTool(),
      sketchSelectionCount: deps.sketchSelectionCount(),
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
      // The edges were picked on a particular body, and their indices only mean anything
      // against that body's shape.
      const target = targetFeature();
      if (target.reason) { deps.notify(target.reason, 'error'); return null; }
      const source = target.id;
      if (!source) {
        deps.notify('Nothing to modify', 'error');
        return null;
      }
      const refs = await deps.captureRefs(source, 'edge', edges.map((e) => e.index));
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

    /**
     * Sensible starting values per feature type.
     *
     * Kept as data so a new feature needs an entry here rather than a new code path.
     */
    async addSolidFeature(type) {
      const needsFaces = new Set(['shell', 'draft']);

      const target = targetFeature();
      if (target.reason) { deps.notify(target.reason, 'error'); return null; }
      const source = target.id;
      if (!source) { deps.notify('Nothing to work from yet', 'error'); return null; }

      // Seat the defaults on the body being worked on — not on everything on screen. A
      // hole centred on the midpoint of two bodies 60mm apart lands in the gap between
      // them, cuts nothing, and reports success.
      const box = (source && viewer.bodies.get(source as unknown as string)?.data.bounds)
        ?? viewer.bounds();
      const size = box
        ? Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z)
        : 20;
      const mid = (lo: number, hi: number) => (lo + hi) / 2;
      const round = (n: number) => String(Math.round(n * 100) / 100);

      const defaults: Record<string, Record<string, string>> = {
        revolve: { angle: '360', axisZ: '1' },
        shell: { thickness: '2' },
        mirror: {
          normalX: '1', keepOriginal: '1',
          x: box ? round(box.min.x) : '0',
        },
        linearPattern: { count: '3', spacing: round(size * 1.5), dx: '1' },
        circularPattern: {
          count: '6', angle: '360', axisZ: '1',
          ...(box ? { x: round(mid(box.min.x, box.max.x)), y: round(mid(box.min.y, box.max.y)) } : {}),
        },
        hole: {
          standard: 'M3', fit: 'normal', style: 'simple',
          x: box ? round(mid(box.min.x, box.max.x)) : '0',
          y: box ? round(mid(box.min.y, box.max.y)) : '0',
          // Start at the top of the part and drill clear through it.
          z: box ? round(box.max.z) : '10',
          depth: box ? round((box.max.z - box.min.z) + 1) : '10',
        },
        extrude: { distance: '10' },
        draft: { angle: '3', pullZ: '1', neutralZ: box ? round(box.min.z) : '0' },
        sweep: {},
        loft: { ruled: '0' },
      };

      const definition = doc.registry.get(type);
      if (!definition) { deps.notify(`Unknown feature "${type}"`, 'error'); return null; }

      // Features that consume picked geometry get the current selection, captured as
      // durable references. Shell is the one here; the rest simply ignore it.
      const selections: Record<string, TopoRef[]> = {};
      const picked = viewer.selection.selected.filter((r) => r.kind === 'face');
      if (needsFaces.has(type)) {
        if (picked.length === 0) {
          deps.notify('Select the faces to open first', 'error');
          return null;
        }
        const refs = await deps.captureRefs(source, 'face', picked.map((f) => f.index));
        if (refs.length === 0) {
          deps.notify('Could not identify those faces', 'error');
          return null;
        }
        selections.faces = refs;
      }

      /*
       * Wire the shape inputs.
       *
       * A one-input feature attaches to the current body. A feature wanting more —
       * a sweep needs a profile and a path, a loft needs sections — takes the most
       * recent leaves in the order they were made, which is the order the user drew
       * them. The panel then lets them be re-pointed; guessing wrong is cheap, and
       * having to pick two things before the button does anything is not.
       */
      const roles = definition.shapeInputs;
      const inputs: Record<string, FeatureId> = {};
      if (roles.length <= 1) {
        const role = definition.primaryInput ?? roles[0];
        if (role) inputs[role] = source;
      } else {
        const available = leafFeatures().slice(-roles.length);
        if (available.length < roles.length) {
          deps.notify(
            `${definition.label} needs ${roles.length} sketches or bodies`, 'error',
          );
          return null;
        }
        roles.forEach((role, i) => { inputs[role] = available[i]!; });
      }

      const id = doc.newFeatureId(type);
      doc.addFeature({
        id, type, name: nameFor(type),
        values: defaults[type] ?? {},
        inputs,
        selections,
      });
      viewer.selection.clear();

      deps.setFocused(id);
      await deps.rebuild();
      viewer.fitAll();
      deps.openPanel(id);
      return id;
    },

    async addBoolean(op) {
      // Which two bodies is a question with an answer the user may already have given:
      // selecting them says it outright, and for a cut it says WHICH WAY ROUND, which
      // guessing cannot. First picked is the base, second the tool.
      const picked: FeatureId[] = [];
      for (const ref of viewer.selection.selected) {
        const owner = ref.bodyId as unknown as FeatureId;
        if (!picked.includes(owner) && doc.feature(owner)) picked.push(owner);
      }

      const leaves = leafFeatures();
      if (picked.length < 2 && leaves.length < 2) {
        deps.notify('Needs two separate bodies to combine', 'error');
        return null;
      }
      if (picked.length > 2) {
        deps.notify('Select two bodies to combine', 'error');
        return null;
      }

      // Falling back to the two most recent leaves: base first, tool second, matching
      // the order the user built them in.
      const [base, tool] = picked.length === 2
        ? picked
        : [leaves.at(-2)!, leaves.at(-1)!];
      const id = doc.newFeatureId(op);
      doc.addFeature({
        id, type: op, name: nameFor(op), values: {},
        inputs: { base: base!, tool: tool! },
      });
      viewer.selection.clear();
      deps.setFocused(id);
      await deps.rebuild();
      return id;
    },

    async addMove() {
      const target = targetFeature();
      if (target.reason) { deps.notify(target.reason, 'error'); return null; }
      const source = target.id;
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

    /**
     * Delete whatever is selected, meaning whatever the user is looking at.
     *
     * Three cases, one key. Inside a sketch, Delete removes the drawn geometry — a line,
     * not the sketch. Outside one, picking ANY part of a body means that body: nobody
     * selects a face in order to delete just the face, and a feature focused in the tree
     * is the same intent expressed a different way.
     */
    async deleteFocused() {
      if (deps.sketching()) return deps.deleteSketchSelection();

      // A picked face, edge or vertex names the body it belongs to.
      const picked = viewer.selection.selected[0]?.bodyId as unknown as FeatureId | undefined;
      const id = (picked && doc.feature(picked) ? picked : null) ?? deps.focused();
      if (!id) { deps.notify('Nothing selected to delete', 'error'); return false; }

      const removed = doc.removeFeature(id);
      if (removed) {
        viewer.selection.clear();
        deps.setFocused(null);
        await deps.rebuild();
      }
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
      // A focused sketch is the one the user is looking at, and picking an older sketch
      // in the tree to extrude it is a reasonable thing to do. Otherwise the most recent
      // sketch is the one just drawn, which is what "extrude" means right after
      // finishing one.
      const focused = deps.focused();
      const focusedSketch = focused ? doc.feature(focused) : null;
      const sketchFeature = focusedSketch?.type === 'sketch'
        ? focusedSketch
        : [...doc.features].reverse().find((f) => f.type === 'sketch');
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
    openAbout: () => deps.openAbout(),
    openPanel: (id) => deps.openPanel(id),
    notify: (message, kind) => deps.notify(message, kind),
  };
}

export { asFeatureId };
