import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { asFeatureId, type FeatureId } from '@cardstock/types';
import { Document, evaluateExpression } from '@cardstock/document';
import { createWorkerKernel } from '@cardstock/kernel';
import { KeyboardCameraInput, Viewer } from '@cardstock/viewer';
import {
  CommandRegistry, chordFromEvent, contextForSelection, createBuiltinCommands,
  type CommandContext, type CommandState,
} from '@cardstock/commands';
import {
  CommandPalette, FeatureTree, ParameterPanel, RadialMenu, StatusBar, Toolbar,
  type FeatureRow, type FieldSpec,
} from '@cardstock/ui';
import {
  captureEdgeRefs, rebuild, terminalFeature, type RebuildReport,
} from './wiring/model-bridge.js';
import { createHost } from './wiring/host.js';
import { downloadStl } from './wiring/download.js';

/** Features whose output nothing else consumes — the things a boolean can combine. */
function leafBodyCount(doc: Document): number {
  const consumed = new Set<string>();
  for (const feature of doc.features) {
    for (const input of Object.values(feature.inputs)) consumed.add(input as string);
  }
  return doc.features.filter((f) => !consumed.has(f.id as string)).length;
}

/** Field labels, so the panel reads as dimensions rather than as variable names. */
const FIELD_LABELS: Record<string, string> = {
  dx: 'length', dy: 'width', dz: 'height',
  radius: 'radius', height: 'height', distance: 'distance',
  x: 'x', y: 'y', z: 'z',
};

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const [, forceRender] = useState(0);
  const repaint = useCallback(() => forceRender((n) => n + 1), []);

  const [focused, setFocused] = useState<FeatureId | null>(null);
  const [radial, setRadial] = useState<{ context: CommandContext; at: { x: number; y: number } } | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [notice, setNotice] = useState<{ text: string; kind: 'info' | 'error' } | null>(null);
  const [report, setReport] = useState<{
    rebuildMs: number | null; meshMs: number | null;
    triangles: number | null; faces: number | null; cached: number; error: string | null;
  }>({ rebuildMs: null, meshMs: null, triangles: null, faces: null, cached: 0, error: null });

  const core = useRef<{
    viewer: Viewer; doc: Document; kernel: ReturnType<typeof createWorkerKernel>;
    registry: CommandRegistry; busy: boolean;
    handles: Map<string, string>;
  } | null>(null);

  // ---------------------------------------------------------------- boot
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || core.current) return;

    const viewer = new Viewer(canvas);
    const kernel = createWorkerKernel();
    const doc = new Document(kernel);
    const registry = new CommandRegistry();
    const handles = new Map<string, string>();
    core.current = { viewer, doc, kernel, registry, busy: false, handles };

    const notify = (text: string, kind: 'info' | 'error' = 'info') => {
      setNotice({ text, kind });
      setTimeout(() => setNotice(null), 3200);
    };

    const doRebuild = async () => {
      core.current!.busy = true;
      repaint();
      const result = await rebuild(doc, kernel, viewer);
      handles.clear();
      for (const [id, state] of result.result.states) {
        if (state.handle) handles.set(id, state.handle);
      }
      core.current!.busy = false;
      setReport(summarise(result));
      repaint();
    };

    const host = createHost({
      doc, viewer,
      terminalFeature: () => terminalFeature(doc),
      captureEdgeRefs: (feature, indices) =>
        captureEdgeRefs(doc, kernel, feature, indices, (id) => handles.get(id) ?? null),
      rebuild: doRebuild,
      exportStl: async () => {
        const terminal = terminalFeature(doc);
        const handle = terminal ? handles.get(terminal) : null;
        if (!handle) { notify('Nothing to export', 'error'); return; }
        const bytes = await kernel.exportStl(handle as never);
        downloadStl(bytes, `${doc.meta.name || 'part'}.stl`);
        notify(`Exported ${(bytes.length / 1024).toFixed(0)} kB`);
      },
      openPalette: () => setPaletteOpen(true),
      openPanel: (id) => setFocused(id),
      notify,
      focused: () => focusedRef.current,
      setFocused: (id) => { focusedRef.current = id; setFocused(id); },
      busy: () => core.current!.busy,
    });
    registry.registerAll(createBuiltinCommands(host));

    const keyboard = new KeyboardCameraInput(viewer);
    keyboard.attach();
    viewer.selection.subscribe(repaint);
    viewer.start();

    const observer = new ResizeObserver(() => viewer.resize());
    observer.observe(canvas);

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
    });

    return () => { observer.disconnect(); keyboard.detach(); viewer.dispose(); };
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
        busy: true, focusedFeature: null,
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
  const fields: FieldSpec[] = focusedFeature
    ? Object.entries(focusedFeature.values).map(([key, value]) => ({
        key, label: FIELD_LABELS[key] ?? key, value,
      }))
    : [];
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
        onPointerMove={(e) => core.current?.viewer.setPointer(e.clientX, e.clientY)}
        onPointerLeave={() => core.current?.viewer.clearPointer()}
        onPointerDown={(e) => {
          canvasRef.current?.focus();
          if (e.button === 0) core.current?.viewer.clickAt(e.clientX, e.clientY, e.shiftKey);
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

      {paletteOpen && registry && (
        <CommandPalette
          registry={registry}
          state={state}
          onRun={run}
          onClose={() => setPaletteOpen(false)}
        />
      )}

      {notice && <div className={`notice notice-${notice.kind}`}>{notice.text}</div>}
    </div>
  );

  function rebuildNow() {
    const c = core.current;
    if (!c) return;
    void (async () => {
      c.busy = true; repaint();
      const result = await rebuild(c.doc, c.kernel, c.viewer);
      c.handles.clear();
      for (const [id, s] of result.result.states) if (s.handle) c.handles.set(id, s.handle);
      c.busy = false;
      setReport(summarise(result));
      repaint();
    })();
  }
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
