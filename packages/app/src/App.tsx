import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SolveRequest, SolveResult, SolverPort } from '@cardstock/types';
import { asFeatureId, type FeatureId } from '@cardstock/types';
import {
  Document, evaluateExpression, placementForFaceIndex, resolvePlacement, resolveTopoRef,
} from '@cardstock/document';
import { PlaneGcsSolver, createWorkerKernel } from '@cardstock/kernel';
import { KeyboardCameraInput, Viewer } from '@cardstock/viewer';
import {
  CommandRegistry, chordFromEvent, contextForSelection, createBuiltinCommands,
  type CommandContext, type CommandState,
} from '@cardstock/commands';
import {
  AboutDialog, CommandPalette, FeatureTree, ParameterPanel, RadialMenu, StatusBar, Toolbar,
  type AboutInfo,
  type FeatureRow, type FieldSpec,
} from '@cardstock/ui';
import {
  captureRefs, captureFaceRef, leafFeatures, rebuild, terminalFeature,
  type RebuildReport,
} from './wiring/model-bridge.js';
import { createHost } from './wiring/host.js';
import { SketchSession } from './wiring/sketch-session.js';
import { downloadStl } from './wiring/download.js';

/**
 * Build identity, injected by Vite at build time — see vite.config.ts.
 *
 * Declared rather than imported because there is no module to import: it is a `define`
 * substitution, which is why the shape has to be repeated here.
 */
declare const __BUILD__: AboutInfo;
const BUILD: AboutInfo = __BUILD__;

/** Features whose output nothing else consumes — the things a boolean can combine. */
function leafBodyCount(doc: Document): number {
  const consumed = new Set<string>();
  for (const feature of doc.features) {
    for (const input of Object.values(feature.inputs)) consumed.add(input as string);
  }
  return doc.features.filter((f) => !consumed.has(f.id as string)).length;
}

/** Field labels, so the panel reads as dimensions rather than as variable names. */
/**
 * Human labels for feature fields.
 *
 * Looked up as `type.key` first, then `key`: `dx` is a box's length but a linear
 * pattern's direction, and reading "length" over a direction component is worse than
 * reading the raw key.
 */
const FIELD_LABELS: Record<string, string> = {
  dx: 'length', dy: 'width', dz: 'height',
  radius: 'radius', height: 'height', distance: 'distance',
  x: 'x', y: 'y', z: 'z',

  'hole.standard': 'fastener', 'hole.fit': 'fit', 'hole.style': 'style',
  'hole.x': 'centre x', 'hole.y': 'centre y', 'hole.z': 'top of hole',
  'hole.diameter': 'diameter (overrides fastener)',
  'hole.compensation': 'FDM compensation',
  'hole.counterboreDepth': 'counterbore depth',

  'shell.thickness': 'wall thickness',

  'draft.angle': 'taper \u00b0', 'draft.neutralZ': 'pivot height',
  'draft.pullX': 'pull x', 'draft.pullY': 'pull y', 'draft.pullZ': 'pull z',

  'loft.ruled': 'straight sides (1/0)',

  'revolve.angle': 'angle °',
  'revolve.axisX': 'axis x', 'revolve.axisY': 'axis y', 'revolve.axisZ': 'axis z',

  'mirror.normalX': 'plane normal x', 'mirror.normalY': 'plane normal y',
  'mirror.normalZ': 'plane normal z', 'mirror.keepOriginal': 'keep original (1/0)',
  'mirror.x': 'plane through x', 'mirror.y': 'plane through y', 'mirror.z': 'plane through z',

  'linearPattern.count': 'copies', 'linearPattern.spacing': 'spacing',
  'linearPattern.dx': 'direction x', 'linearPattern.dy': 'direction y',
  'linearPattern.dz': 'direction z',

  'circularPattern.count': 'copies', 'circularPattern.angle': 'sweep °',
  'circularPattern.x': 'centre x', 'circularPattern.y': 'centre y',
  'circularPattern.z': 'centre z',
  'circularPattern.axisX': 'axis x', 'circularPattern.axisY': 'axis y',
  'circularPattern.axisZ': 'axis z',
};

/** Fields that are not lengths, by `type.key` then `key`. Everything else is mm. */
const FIELD_UNITS: Record<string, string> = {
  angle: '\u00b0', count: '', keepOriginal: '',
  axisX: '', axisY: '', axisZ: '',
  normalX: '', normalY: '', normalZ: '',
  // A box's dx is a length; a pattern's dx is a direction component.
  'linearPattern.dx': '', 'linearPattern.dy': '', 'linearPattern.dz': '',
  'draft.pullX': '', 'draft.pullY': '', 'draft.pullZ': '',
  ruled: '', symmetric: '',
};

/**
 * Loads PlaneGCS on first use.
 *
 * The Document needs a SolverPort at construction, but the WASM module is async. Waiting
 * for it before showing anything would delay the whole app for a solver most sessions
 * never touch.
 */
class LazySolver implements SolverPort {
  #solver: Promise<SolverPort> | null = null;

  solve(request: SolveRequest): Promise<SolveResult> {
    this.#solver ??= PlaneGcsSolver.create();
    return this.#solver.then((solver) => solver.solve(request));
  }
}

/**
 * Start the things that cleanup tears down: the render loop, camera keys, resize.
 *
 * One function, used by both the first effect run and every StrictMode re-run, so a
 * binding cannot be present on one path and missing on the other.
 */
function activate(viewer: Viewer, canvas: HTMLCanvasElement): () => void {
  viewer.resize();
  viewer.start();

  const keyboard = new KeyboardCameraInput(viewer);
  keyboard.attach();

  const observer = new ResizeObserver(() => viewer.resize());
  observer.observe(canvas);

  return () => {
    observer.disconnect();
    keyboard.detach();
    viewer.stop();
  };
}

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const [, forceRender] = useState(0);
  const repaint = useCallback(() => forceRender((n) => n + 1), []);
  /** Bumped per rebuild, so a superseded run can tell and stand down. */
  const rebuildGeneration = useRef(0);

  const [focused, setFocused] = useState<FeatureId | null>(null);
  const [radial, setRadial] = useState<{ context: CommandContext; at: { x: number; y: number } } | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [notice, setNotice] = useState<{ text: string; kind: 'info' | 'error' } | null>(null);
  const [sketchInfo, setSketchInfo] = useState<{
    open: boolean; tool: string; dof: number | null; status: string;
    inference: string | null; selected: number;
  } | null>(null);
  const sessionRef = useRef<SketchSession | null>(null);
  const [dimensions, setDimensions] = useState<
    { id: string; text: string; expression: string; error?: string }[]>([]);
  const [editingDimension, setEditingDimension] = useState<string | null>(null);
  const dimensionLayer = useRef<HTMLDivElement>(null);
  const [report, setReport] = useState<{
    rebuildMs: number | null; meshMs: number | null;
    triangles: number | null; faces: number | null; cached: number; error: string | null;
  }>({ rebuildMs: null, meshMs: null, triangles: null, faces: null, cached: 0, error: null });

  const core = useRef<{
    viewer: Viewer; doc: Document; kernel: ReturnType<typeof createWorkerKernel>;
    registry: CommandRegistry; busy: boolean;
    handles: Map<string, string>;
    solver: SolverPort;
  } | null>(null);

  // ---------------------------------------------------------------- boot
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // CONSTRUCTION happens once; ACTIVATION happens on every effect run.
    //
    // StrictMode double-invokes effects, so the two must be separated: the viewer,
    // worker and document are session-scoped singletons, while the render loop, the
    // keyboard binding and the resize observer are torn down by cleanup and have to be
    // re-established. An earlier version had a second, abbreviated activation path for
    // the already-built case, and it silently omitted the keyboard — which is exactly
    // why there is only one activation path now.
    if (core.current) return activate(core.current.viewer, canvas);

    const viewer = new Viewer(canvas);
    const kernel = createWorkerKernel();
    // The constraint solver runs on the main thread: it boots in ~13ms and solves a
    // sketch in under a millisecond (ADR-0003), so a worker hop would cost more than it
    // saves and would put a round trip in the middle of dragging.
    const solver = new LazySolver();
    const doc = new Document(kernel, undefined, solver);
    const registry = new CommandRegistry();
    const handles = new Map<string, string>();
    core.current = { viewer, doc, kernel, registry, busy: false, handles, solver };

    const notify = (text: string, kind: 'info' | 'error' = 'info') => {
      setNotice({ text, kind });
      setTimeout(() => setNotice(null), 3200);
    };

    // One implementation, so the sketch path and the modelling path cannot drift: both
    // had the same missing guard, and only one of them would have been noticed.
    const doRebuild = () => runRebuild();

    const syncSketch = (inference: string | null = null) => {
      const session = sessionRef.current;
      setDimensions(session
        ? session.dimensions().map(({ id, text, expression, error }) => ({
            id, text, expression, ...(error ? { error } : {}),
          }))
        : []);
      setSketchInfo(session ? {
        open: true,
        tool: session.tools.kind,
        dof: session.sketch.dof,
        status: session.sketch.status,
        inference,
        selected: session.selected.size,
      } : null);
    };

    const host = createHost({
      doc, viewer,
      terminalFeature: () => terminalFeature(doc),
      captureRefs: (feature, kind, indices) =>
        captureRefs(kernel, feature, kind, indices, (id) => handles.get(id) ?? null),
      rebuild: doRebuild,
      exportStl: async () => {
        // Every body on screen, not just the last one. A part built from several
        // sketches is several leaves, and exporting only the terminal feature writes a
        // file missing most of the part — with nothing to say so.
        const bodies = leafFeatures(doc)
          .map((id) => handles.get(id))
          .filter((h): h is string => h !== undefined);
        if (bodies.length === 0) { notify('Nothing to export', 'error'); return; }

        const shape = bodies.length === 1
          ? bodies[0]!
          : (await kernel.compound(bodies as never[])).handle;
        const bytes = await kernel.exportStl(shape as never);
        downloadStl(bytes, `${doc.meta.name || 'part'}.stl`);
        notify(
          bodies.length === 1
            ? `Exported ${(bytes.length / 1024).toFixed(0)} kB`
            : `Exported ${bodies.length} bodies, ${(bytes.length / 1024).toFixed(0)} kB`,
        );
      },
      openPalette: () => setPaletteOpen(true),
      openAbout: () => setAboutOpen(true),
      openPanel: (id) => setFocused(id),
      notify,
      beginSketch: async (plane) => {
        sessionRef.current?.close();
        const session = SketchSession.open(doc, viewer, plane);
        sessionRef.current = session;
        session.alignCamera();
        // Selecting the body underneath while drawing on top of it is only confusing.
        viewer.selection.clear();
        session.setTool('line');
        await doRebuild();
        syncSketch();
      },
      finishSketch: async () => {
        const session = sessionRef.current;
        if (!session) return;
        session.close();
        sessionRef.current = null;
        setSketchInfo(null);
        await doRebuild();
        viewer.fitAll();
        repaint();
      },
      beginSketchOnFace: async () => {
        const face = viewer.selection.selected.find((r) => r.kind === 'face');
        // The body the face was picked ON, not whichever feature happens to be last: a
        // face index only means anything against the shape it came from, so taking the
        // wrong one would resolve to a real but unrelated face on another body.
        const base = face ? (face.bodyId as unknown as FeatureId) : null;
        if (!face || !base || !doc.feature(base)) {
          notify('Select a flat face first', 'error');
          return false;
        }

        const ref = await captureFaceRef(kernel, base, face.index, (id) => handles.get(id) ?? null);
        const handle = handles.get(base);
        if (!ref || !handle) { notify('Could not identify that face', 'error'); return false; }

        const description = await kernel.describeShape(handle as never);
        const placement = placementForFaceIndex(description, face.index);
        if (!placement) { notify('That face is not flat enough to sketch on', 'error'); return false; }

        sessionRef.current?.close();
        const session = SketchSession.onFace(doc, viewer, ref, placement, base);
        sessionRef.current = session;
        session.alignCamera();
        viewer.selection.clear();
        session.setTool('line');
        await doRebuild();
        syncSketch();
        return true;
      },

      editSketch: async () => {
        const id = focusedRef.current;
        const feature = id ? doc.feature(id) : null;
        if (!id || feature?.type !== 'sketch') {
          notify('Select a sketch in the tree first', 'error');
          return false;
        }
        const sketch = doc.sketchFor(id);
        if (!sketch) { notify('That sketch is missing', 'error'); return false; }

        // Re-derive the plane the same way the rebuild does, so editing and building
        // never disagree about where the sketch is.
        let placement = resolvePlacement(sketch.plane);
        if (!placement && sketch.plane.kind === 'face') {
          const base = feature.inputs.base;
          const handle = base ? handles.get(base) : null;
          if (handle) {
            const description = await kernel.describeShape(handle as never);
            const resolved = resolveTopoRef(sketch.plane.ref, description);
            if (resolved.ok) placement = placementForFaceIndex(description, resolved.index);
          }
        }
        if (!placement) { notify('That sketch plane could not be resolved', 'error'); return false; }

        const session = SketchSession.reopen(doc, viewer, id, placement);
        if (!session) return false;
        sessionRef.current = session;
        session.alignCamera();
        viewer.selection.clear();
        session.setTool('select');
        syncSketch();
        return true;
      },

      deleteSketchSelection: () => {
        const removed = sessionRef.current?.deleteSelected() ?? false;
        if (removed) { syncSketch(); void doRebuild(); }
        return removed;
      },

      setSketchTool: (tool) => { sessionRef.current?.setTool(tool); syncSketch(); },
      sketching: () => sessionRef.current !== null,
      sketchTool: () => sessionRef.current?.tools.kind ?? null,
      sketchSelectionCount: () => sessionRef.current?.selected.size ?? 0,

      focused: () => focusedRef.current,
      setFocused: (id) => { focusedRef.current = id; setFocused(id); },
      busy: () => core.current!.busy,
    });
    registry.registerAll(createBuiltinCommands(host));

    viewer.selection.subscribe(repaint);

    // Labels follow the camera by writing transforms directly. Re-rendering React on
    // every frame to move a few divs would be pure waste.
    viewer.onFrame.add(() => {
      const layer = dimensionLayer.current;
      const session = sessionRef.current;
      if (!layer || !session) return;
      const rect = viewer.canvas.getBoundingClientRect();
      for (const dimension of session.dimensions()) {
        const node = layer.querySelector<HTMLElement>(`[data-dimension="${dimension.id}"]`);
        if (!node) continue;
        const ndc = dimension.world.clone().project(viewer.camera);
        node.style.transform =
          `translate(-50%, -50%) translate(${((ndc.x + 1) / 2) * rect.width}px, ` +
          `${((1 - ndc.y) / 2) * rect.height}px)`;
        // Behind the camera, or off screen: hide rather than draw a label in the wrong place.
        node.style.visibility = ndc.z > 1 || Math.abs(ndc.x) > 1.2 || Math.abs(ndc.y) > 1.2
          ? 'hidden' : 'visible';
      }
    });

    const teardown = activate(viewer, canvas);

    void (async () => {
      await kernel.whenReady();
      setReady(true);
      // Start with something on screen; an empty viewport teaches nothing.
      doc.setParameter({ name: 'width', expression: '60', unit: 'mm' });
      doc.addFeature({
        id: asFeatureId('plate'), type: 'box', name: 'Plate',
        values: { dx: 'width', dy: '40', dz: '18' }, inputs: {},
      });
      await doRebuild();
      viewer.fitAll();
      viewer.controller.settle();
    })();

    // Handles for the verification harness. requestAnimationFrame does not run while a
    // browser pane is hidden, so tests must be able to step the viewer explicitly.
    Object.assign(globalThis, {
      __viewer: viewer, __doc: doc, __kernel: kernel, __registry: registry, __host: host,
      __step: (steps = 60, dt = 1 / 60) => { for (let i = 0; i < steps; i++) viewer.step(dt); },
      __session: () => sessionRef.current,
      // The harness needs to undo what it built; a document edit alone leaves the
      // viewer showing the old bodies.
      __rebuild: () => doRebuild(),
    });

    return teardown;
  }, [repaint]);

  const focusedRef = useRef<FeatureId | null>(null);
  useEffect(() => { focusedRef.current = focused; }, [focused]);

  // ---------------------------------------------------------------- command running
  const run = useCallback((id: string) => {
    const command = core.current?.registry.get(id);
    if (!command) return;
    const enabled = command.enabled(hostState());
    if (enabled !== true) { setNotice({ text: String(enabled), kind: 'error' }); return; }
    void command.run();
  }, []);

  const hostState = useCallback((): CommandState => {
    const c = core.current;
    if (!c) {
      return {
        selectionKind: null, selectionCount: 0, hoverKind: null, hasModel: false,
        featureCount: 0, bodyCount: 0, canUndo: false, canRedo: false,
        busy: true, focusedFeature: null, sketching: false, sketchTool: null,
        sketchSelectionCount: 0,
      };
    }
    return {
      selectionKind: c.viewer.selection.selected[0]?.kind ?? null,
      selectionCount: c.viewer.selection.selected.length,
      hoverKind: c.viewer.selection.hover?.kind ?? null,
      hasModel: c.viewer.bodies.size > 0,
      featureCount: c.doc.features.length,
      bodyCount: leafBodyCount(c.doc),
      canUndo: c.doc.canUndo,
      canRedo: c.doc.canRedo,
      busy: c.busy,
      focusedFeature: focusedRef.current,
      sketching: sessionRef.current !== null,
      sketchTool: sessionRef.current?.tools.kind ?? null,
      sketchSelectionCount: sessionRef.current?.selected.size ?? 0,
    };
  }, []);

  // ---------------------------------------------------------------- keybindings
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) {
        return; // never steal keys from a field
      }
      const command = core.current?.registry.commandForChord(chordFromEvent(e));
      if (!command) return;
      e.preventDefault();
      if (command.enabled(hostState()) === true) void command.run();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hostState]);

  // ---------------------------------------------------------------- derived view data
  const state = hostState();
  const registry = core.current?.registry;
  const doc = core.current?.doc;
  const viewer = core.current?.viewer;

  const evaluate = useCallback((expression: string) => {
    const scope = core.current?.doc.parameters.scope() ?? (() => undefined);
    try {
      return { ok: true as const, value: evaluateExpression(expression, scope) };
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  }, []);

  const rows: FeatureRow[] = useMemo(() => {
    if (!doc) return [];
    const states = core.current?.doc.engine.lastStates;
    return doc.features.map((feature) => {
      const featureState = states?.get(feature.id);
      return {
        id: feature.id,
        name: feature.name,
        type: feature.type,
        status: featureState?.status ?? 'blocked',
        ...(featureState?.message ? { message: featureState.message } : {}),
      };
    });
  }, [doc, report]);

  const focusedFeature = focused && doc ? doc.feature(focused) : null;
  const focusedDefinition = focusedFeature ? doc?.registry.get(focusedFeature.type) : undefined;
  const unitFor = (type: string, key: string) => {
    const unit = FIELD_UNITS[`${type}.${key}`] ?? FIELD_UNITS[key];
    return unit === undefined ? {} : { unit };
  };
  /**
   * Every field the feature declares, not just the ones it happens to hold a value for.
   *
   * A pattern created with only a direction-x would otherwise offer no way to type a
   * direction-y — the field simply wouldn't exist. Unset numeric fields show 0, which is
   * their real effective value: a hole's diameter of 0 means "take it from the fastener
   * table", which is exactly what leaving it unset does.
   */
  const fields: FieldSpec[] = (() => {
    if (!focusedFeature) return [];
    const { type, values } = focusedFeature;
    const declared = focusedDefinition
      ? [...Object.keys(focusedDefinition.choiceKeys ?? {}), ...focusedDefinition.valueKeys]
      : [];
    const keys = [...new Set([...declared, ...Object.keys(values)])];
    return keys.map((key) => {
      const choices = focusedDefinition?.choiceKeys?.[key];
      return {
        key,
        label: FIELD_LABELS[`${type}.${key}`] ?? FIELD_LABELS[key] ?? key,
        value: values[key] ?? (choices ? choices[0]! : '0'),
        ...(unitFor(type, key)),
        ...(choices ? { choices } : {}),
      };
    });
  })();
  const parameters: FieldSpec[] = doc
    ? doc.parameters.all().map((p) => ({ key: p.name, label: p.name, value: p.expression }))
    : [];

  const hoverText = (() => {
    const hover = viewer?.selection.hover;
    const pick = viewer?.lastPick;
    if (!hover || !pick) return null;
    return `${hover.kind} #${hover.index} at ${pick.point.x.toFixed(1)}, ${pick.point.y.toFixed(1)}, ${pick.point.z.toFixed(1)}`;
  })();

  // ---------------------------------------------------------------- render
  return (
    <div className="shell">
      <canvas
        ref={canvasRef}
        id="stage"
        tabIndex={0}
        onPointerMove={(e) => {
          core.current?.viewer.setPointer(e.clientX, e.clientY);
          const session = sessionRef.current;
          if (session?.isDragging) {
            const solver = core.current?.solver;
            if (solver) void session.updateDrag(solver, parameterValues());
            return;
          }
          if (session) {
            const inference = session.updatePreview();
            // Only re-render React when the hint actually changes; this fires on every
            // mouse move.
            if (inference !== sketchInfo?.inference) {
              setSketchInfo((current) => (current ? { ...current, inference } : current));
            }
          }
        }}
        onPointerLeave={() => core.current?.viewer.clearPointer()}
        onPointerUp={(e) => {
          const session = sessionRef.current;
          if (session?.endDrag()) {
            canvasRef.current?.releasePointerCapture(e.pointerId);
            syncSketchFromApp();
            rebuildNow();
          }
        }}
        onPointerDown={(e) => {
          canvasRef.current?.focus();
          if (e.button !== 0) return;
          const session = sessionRef.current;
          if (session) {
            core.current?.viewer.setPointer(e.clientX, e.clientY);
            if (session.tools.kind === 'dimension') {
              const { placed } = session.placeDimension();
              syncSketchFromApp();
              if (placed) { setEditingDimension(placed); rebuildNow(); }
              return;
            }
            if (session.tools.kind === 'select') {
              // Pressing on a point starts a drag; pressing elsewhere selects.
              if (session.beginDrag()) {
                canvasRef.current?.setPointerCapture(e.pointerId);
                return;
              }
              session.toggleSelection(session.pick(), e.shiftKey);
              setSketchInfo((current) => (current
                ? { ...current, selected: session.selected.size }
                : current));
              return;
            }
            // Otherwise a click draws.
            if (session.click()) {
              setSketchInfo((current) => (current ? {
                ...current, dof: session.sketch.dof, status: session.sketch.status,
              } : current));
              // Rebuild as you draw. Without this the sketch feature keeps whatever
              // state it had before the first click, so a finished profile still reads
              // "no closed profile" in the tree until something else forces a rebuild.
              rebuildNow();
            }
            return;
          }
          core.current?.viewer.clickAt(e.clientX, e.clientY, e.shiftKey);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          const v = core.current?.viewer;
          if (!v) return;
          v.setPointer(e.clientX, e.clientY);
          const pick = v.pickAtPointer();
          setRadial({
            context: contextForSelection(pick?.ref.kind ?? null, v.selection.selected[0]?.kind ?? null),
            at: { x: e.clientX, y: e.clientY },
          });
        }}
        onWheel={(e) => {
          const c = core.current;
          if (c) c.viewer.controller.target.zoom *= Math.exp(Math.sign(e.deltaY) * 0.12);
        }}
      />

      {registry && <Toolbar registry={registry} state={state} onRun={run} />}

      {doc && (
        <div className="left-rail">
          <FeatureTree
            rows={rows}
            focused={focused}
            onFocus={setFocused}
            onContextMenu={(id, at) => { setFocused(id); setRadial({ context: 'tree-item', at }); }}
            onReorder={(id, toIndex) => {
              const result = doc.moveFeature(id, toIndex);
              if (!result.ok) setNotice({ text: result.reason ?? 'Cannot move there', kind: 'error' });
              else rebuildNow();
            }}
          />
          <ParameterPanel
            title={focusedFeature?.name || 'Document'}
            {...(focusedFeature ? { subtitle: focusedFeature.type } : {})}
            fields={fields}
            parameters={parameters}
            evaluate={evaluate}
            onCommit={(key, expression) => {
              if (!focused) return;
              doc.updateFeature(focused, { values: { [key]: expression } },
                { coalesceKey: `feature:${focused}:${key}` });
              rebuildNow();
            }}
            onCommitParameter={(name, expression) => {
              doc.setParameter({ name, expression, unit: 'mm' },
                { coalesceKey: `param:${name}` });
              rebuildNow();
            }}
          />
        </div>
      )}

      <StatusBar
        hover={hoverText}
        filter={viewer?.selection.filter ?? 'face'}
        selectionCount={state.selectionCount}
        rebuildMs={report.rebuildMs}
        meshMs={report.meshMs}
        triangles={report.triangles}
        faces={report.faces}
        cached={report.cached}
        error={report.error}
        busy={!ready || state.busy}
      />

      {radial && registry && (
        <RadialMenu
          registry={registry}
          state={state}
          context={radial.context}
          at={radial.at}
          onRun={run}
          onClose={() => setRadial(null)}
        />
      )}

      {aboutOpen && (
        <AboutDialog info={BUILD} author="Rutledge Dixon" onClose={() => setAboutOpen(false)} />
      )}

      {paletteOpen && registry && (
        <CommandPalette
          registry={registry}
          state={state}
          onRun={run}
          onClose={() => setPaletteOpen(false)}
        />
      )}

      {/* Dimension labels, positioned each frame from their 3D anchor. */}
      {sketchInfo?.open && (
        <div className="dimension-layer" ref={dimensionLayer}>
          {dimensions.map((dimension) => (
            <div
              key={dimension.id}
              data-dimension={dimension.id}
              className={`dimension${dimension.error ? ' is-invalid' : ''}`}
              title={dimension.error ?? dimension.expression}
            >
              {editingDimension === dimension.id ? (
                <input
                  autoFocus
                  defaultValue={dimension.expression}
                  spellCheck={false}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Escape') { setEditingDimension(null); return; }
                    if (e.key !== 'Enter') return;
                    const error = sessionRef.current?.setDimension(
                      dimension.id, e.currentTarget.value);
                    if (error) { setNotice({ text: error, kind: 'error' }); return; }
                    setEditingDimension(null);
                    syncSketchFromApp();
                    rebuildNow();
                  }}
                  onBlur={(e) => {
                    sessionRef.current?.setDimension(dimension.id, e.currentTarget.value);
                    setEditingDimension(null);
                    syncSketchFromApp();
                    rebuildNow();
                  }}
                />
              ) : (
                <button
                  type="button"
                  onPointerDown={(e) => { e.stopPropagation(); setEditingDimension(dimension.id); }}
                >
                  {dimension.text}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {sketchInfo?.open && (
        <div className="sketchbar">
          <span className="sketchbar-title">Sketch</span>
          <span className="sketchbar-tools">
            {(['line', 'rectangle', 'circle', 'dimension', 'select'] as const).map((tool) => (
              <button
                key={tool}
                type="button"
                className={sketchInfo.tool === tool ? 'is-active' : ''}
                onClick={() => run(`sketch.${tool}`)}
              >
                {tool}
              </button>
            ))}
          </span>

          {/* The number you are always asking about while sketching. */}
          <span className={`sketchbar-dof status-${sketchInfo.status}`}>
            {sketchInfo.dof === null ? '—'
              : sketchInfo.dof === 0 ? 'fully constrained'
              : `${sketchInfo.dof} DOF`}
          </span>

          {/* Say what is about to be assumed, before the click lands. */}
          {sketchInfo.inference && (
            <span className="sketchbar-inference">{sketchInfo.inference}</span>
          )}

          {sketchInfo.selected > 0 && (
            <>
              <span className="sel">{sketchInfo.selected} selected</span>
              <button type="button" className="sketchbar-delete" onClick={() => run('feature.delete')}>
                Delete
              </button>
            </>
          )}

          <button type="button" className="sketchbar-finish" onClick={() => run('sketch.finish')}>
            Finish
          </button>
        </div>
      )}

      {notice && <div className={`notice notice-${notice.kind}`}>{notice.text}</div>}
    </div>
  );

  /** Current parameter values, for solving sketch dimensions that name one. */
  function parameterValues(): Record<string, number> {
    const values: Record<string, number> = {};
    for (const [name, value] of core.current?.doc.parameters.evaluateAll() ?? []) {
      if (value.ok) values[name] = value.value;
    }
    return values;
  }

  /** Mirror the live sketch into React state. */
  function syncSketchFromApp(): void {
    const session = sessionRef.current;
    setDimensions(session
      ? session.dimensions().map(({ id, text, expression, error }) => ({
          id, text, expression, ...(error ? { error } : {}),
        }))
      : []);
    setSketchInfo((current) => (current && session ? {
      ...current,
      tool: session.tools.kind,
      dof: session.sketch.dof,
      status: session.sketch.status,
      selected: session.selected.size,
    } : current));
  }

  /**
   * The one rebuild.
   *
   * Guarded twice. The generation counter stops a superseded run from publishing: rapid
   * edits — which is what typing in the parameter panel or dragging a sketch point is —
   * could otherwise leave an older rebuild tessellating handles the newer run's cache
   * eviction had already freed, and the kernel would throw "unknown shape handle".
   *
   * The finally is the safety net behind that. Without it ANY throw in here left `busy`
   * true and the status bar stuck on "rebuilding…" with no way back short of a reload.
   * A bug is bad; a bug that bricks the session is worse.
   */
  async function runRebuild(): Promise<void> {
    const c = core.current;
    if (!c) return;

    const generation = ++rebuildGeneration.current;
    const superseded = () => rebuildGeneration.current !== generation;

    c.busy = true;
    repaint();
    try {
      const result = await rebuild(
        c.doc, c.kernel, c.viewer, sessionRef.current?.featureId ?? null, superseded,
      );
      if (superseded() || result.abandoned) return;

      c.handles.clear();
      for (const [id, st] of result.result.states) if (st.handle) c.handles.set(id, st.handle);
      setReport(summarise(result));
      // The rebuild re-solves the open sketch, so its DOF and dimensions are only
      // current once it has finished — reading them before would show the state from
      // before the edit that triggered this.
      syncSketchFromApp();
    } catch (e) {
      // A SUPERSEDED run failing is expected, not news: it was abandoned mid-flight and
      // its handles may already be freed. Reporting it would leave "Rebuild failed" in
      // the status bar underneath a model that rebuilt perfectly well.
      if (!superseded()) {
        const message = e instanceof Error ? e.message : String(e);
        setReport((r) => ({ ...r, error: `Rebuild failed: ${message}` }));
      }
    } finally {
      // Only the newest run owns the busy flag: an older one clearing it would report
      // the model settled while the current rebuild is still going.
      if (!superseded()) { c.busy = false; repaint(); }
    }
  }

  function rebuildNow() { void runRebuild(); }
}

/** Roll a rebuild up into the numbers the status bar shows. */
function summarise(result: RebuildReport) {
  const faces = result.bodies.reduce((n, b) => n + b.faceCount, 0);
  const triangles = result.bodies.reduce((n, b) => n + b.indices.length / 3, 0);
  return {
    rebuildMs: result.rebuildMs,
    meshMs: result.bodies.length > 0 ? result.tessellateMs : null,
    triangles: result.bodies.length > 0 ? triangles : null,
    faces: result.bodies.length > 0 ? faces : null,
    cached: result.result.reused.length,
    error: result.errors[0] ?? null,
  };
}
