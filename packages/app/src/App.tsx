import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SolveRequest, SolveResult, SolverPort } from '@cardstock/types';
import { EXPORT_FORMATS, type ExportFormat, type FeatureId, type ShapeHandle, type OrientationSuggestion } from '@cardstock/types';
import {
  Document, applyConstraint, constraintFromSelection, evaluateExpression,
  placementForFaceIndex, resolvePlacement, resolveTopoRef, bytesToBase64, IMPORT_EXTENSIONS,
  DEFAULT_PRINTER, normaliseProfile, profileEnvironment, fitsBed, printEstimates,
  type ApplicableConstraint, type PrinterProfile,
} from '@cardstock/document';
import { PlaneGcsSolver, createWorkerKernel } from '@cardstock/kernel';
import { KeyboardCameraInput, Viewer } from '@cardstock/viewer';
import {
  CommandRegistry, chordFromEvent, contextForSelection, createBuiltinCommands,
  type CommandContext, type CommandState,
} from '@cardstock/commands';
import {
  AboutDialog, CommandPalette, ExportDialog, FeatureTree, ParameterPanel, RadialMenu, StatusBar,
  Submenu, Toolbar, QUALITY_PRESETS, PrinterDialog, OrientationDialog, describeDown, KeysDialog,
  type AboutInfo, type ExportQuality, type ExportStats, type OrientationRow,
  type FeatureRow, type FieldSpec,
} from '@cardstock/ui';
import {
  captureRefs, captureFaceRef, bodyFeatures, rebuild, terminalFeature,
  type RebuildReport,
} from './wiring/model-bridge.js';
import { createHost } from './wiring/host.js';
import { SketchSession } from './wiring/sketch-session.js';
import { defaultStore } from './persistence/store.js';
import { defaultFileAccess, downloadFallback, type FileAccess, type FileLocation, type OpenedFile } from './persistence/files.js';
import { captureThumbnail } from './persistence/thumbnail.js';
import { listRecents, rememberRecent, forgetRecent, type RecentEntry } from './persistence/recents.js';
import { clearAutosave, readAutosave, startAutosave } from './persistence/autosave.js';

/**
 * Build identity, injected by Vite at build time — see vite.config.ts.
 *
 * Declared rather than imported because there is no module to import: it is a `define`
 * substitution, which is why the shape has to be repeated here.
 */
declare const __BUILD__: AboutInfo;
const BUILD: AboutInfo = __BUILD__;

/** Features whose output nothing else consumes — the things a boolean can combine. */
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
  const [keysOpen, setKeysOpen] = useState(false);
  /**
   * Export settings outlive the dialog: a quality chosen once should still be there
   * on the next export. Degrees in the dialog, radians at the kernel.
   */
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>('stl');
  const [exportQuality, setExportQuality] = useState<ExportQuality>(QUALITY_PRESETS[1]!.quality);
  const [exportScope, setExportScope] = useState<'all' | 'selected'>('all');
  /**
   * The print side. The printer is app-wide, not part of the document: a part is
   * designed against a nozzle and a bed, but it is the machine that has those.
   */
  const [printer, setPrinter] = useState<PrinterProfile>(DEFAULT_PRINTER);
  const [printerOpen, setPrinterOpen] = useState(false);
  const [orientOpen, setOrientOpen] = useState(false);
  const [orientRows, setOrientRows] = useState<OrientationSuggestion[] | null>(null);
  /** An orientation chosen for export: rotates the file, never the model. */
  const [exportOrientation, setExportOrientation] = useState<{ index: number; suggestion: OrientationSuggestion } | null>(null);
  const buildVolumeRef = useRef(false);
  const [printFit, setPrintFit] = useState(true);
  const [estimates, setEstimates] = useState<{ cm3: number; grams: number; metres: number } | null>(null);
  const printerRef = useRef<{ profile: PrinterProfile; apply: (p: PrinterProfile, rebuild: boolean) => Promise<void> }>({
    profile: DEFAULT_PRINTER, apply: async () => {},
  });
  const [exportStats, setExportStats] = useState<ExportStats | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const exportRef = useRef<{
    stats: (quality: ExportQuality, scope: 'all' | 'selected') => Promise<ExportStats | null>;
    write: (
      format: ExportFormat, quality: ExportQuality, scope: 'all' | 'selected',
      orientation: OrientationSuggestion | null,
    ) => Promise<void>;
    orientations: () => Promise<OrientationSuggestion[]>;
  }>({ stats: async () => null, write: async () => {}, orientations: async () => [] });
  /**
   * Where the document lives, and whether it has changed since.
   *
   * `handle` is the file it came from, when the browser can hand one over; without it
   * Save behaves as Save As. `savedRevision` against `doc.revision` is what "unsaved
   * changes" means — a counter rather than a flag because autosave compares too.
   */
  const fileRef = useRef<{ handle: FileLocation | null; savedRevision: number }>({
    handle: null, savedRevision: 0,
  });
  const [fileState, setFileState] = useState<{ name: string; dirty: boolean }>({
    name: 'Untitled', dirty: false,
  });
  const [recents, setRecents] = useState<RecentEntry[]>([]);
  const openRecentRef = useRef<(entry: RecentEntry) => Promise<void>>(async () => {});
  /**
   * The feature tree's context menu: a plain flyout, not the radial.
   *
   * The radial is for things in 3D space, where there is room in every direction. A row
   * in the top-left corner has room in one direction, and a ring centred there was cut
   * off by the top and left edges of the page.
   */
  const [treeMenuAt, setTreeMenuAt] = useState<{ top: number; left: number } | null>(null);
  /** Where the sketch bar's constraint flyout sits, or null when closed. */
  const [constraintsAt, setConstraintsAt] = useState<{ top: number; left: number } | null>(null);
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

    const store = defaultStore();
    // Which backend depends on where we are running; it is resolved at boot, below.
    // Until then nothing can save, and the fallback is the honest placeholder.
    let files: FileAccess = downloadFallback;

    /** The file as it should be written: the model, plus where the camera is and what
     *  it sees. Rendered first so the thumbnail is of the current frame, not a stale one. */
    const snapshotForSave = () => {
      viewer.renderer.render(viewer.scene, viewer.camera);
      const thumbnail = captureThumbnail(viewer.canvas);
      const c = viewer.controller.target;
      doc.setSavedView({
        camera: { azimuth: c.azimuth, elevation: c.elevation, zoom: c.zoom, pivot: { ...c.pivot } },
        ...(thumbnail ? { thumbnail } : {}),
      });
      return doc.toJSON();
    };

    const syncFileState = () => setFileState({
      name: doc.meta.name || 'Untitled',
      dirty: doc.revision !== fileRef.current.savedRevision,
    });

    const markSaved = (name: string) => {
      fileRef.current.savedRevision = doc.revision;
      // A saved file supersedes the autosave; keeping both means the next boot offers
      // to "restore" work that is already safely in the file.
      void clearAutosave(store);
      setFileState({ name, dirty: false });
    };

    /** Ask before throwing away unsaved work. True means go ahead. */
    const confirmDiscard = async () => {
      if (doc.revision === fileRef.current.savedRevision) return true;
      const message = `${doc.meta.name || 'This part'} has unsaved changes. Discard them?`;
      return files.confirm ? files.confirm(message) : window.confirm(message);
    };

    /** Put an opened file's contents in place: model, camera, recents, title. */
    const takeFile = async (opened: OpenedFile) => {
      try {
        doc.load(opened.contents);
      } catch (e) {
        notify(`Could not open ${opened.name}: ${e instanceof Error ? e.message : String(e)}`, 'error');
        return;
      }
      fileRef.current = { handle: opened.handle, savedRevision: doc.revision };
      setFocused(null);
      syncFileState();
      await doRebuild();
      const saved = doc.meta.camera;
      if (saved) {
        Object.assign(viewer.controller.target, {
          azimuth: saved.azimuth, elevation: saved.elevation, zoom: saved.zoom,
        });
        Object.assign(viewer.controller.target.pivot, saved.pivot);
        viewer.controller.settle();
      } else {
        viewer.fitAll();
      }
      await remember(opened.name, opened.handle);
      notify(`Opened ${opened.name}`);
    };

    /**
     * Note a file in the recent list. Never fatal: the list is a convenience, and an
     * open that succeeded must not be reported as failed because a bookkeeping write
     * could not clone a handle.
     */
    const remember = async (name: string, handle: FileLocation | null) => {
      try {
        await rememberRecent(store, {
          name, opened: new Date().toISOString(),
          ...(doc.meta.thumbnail ? { thumbnail: doc.meta.thumbnail } : {}),
          ...(handle ? { handle } : {}),
        });
        setRecents(await listRecents(store));
      } catch {
        // Fall back to an entry without the handle; the name and picture still help.
        try {
          await rememberRecent(store, {
            name, opened: new Date().toISOString(),
            ...(doc.meta.thumbnail ? { thumbnail: doc.meta.thumbnail } : {}),
          });
          setRecents(await listRecents(store));
        } catch { /* storage itself is unavailable; nothing to record */ }
      }
    };

    /** Reopen something from the recent list, by handle where we have one. */
    const openRecent = async (entry: RecentEntry) => {
      if (!(await confirmDiscard())) return;
      if (!entry.handle) {
        notify(`${entry.name} was downloaded, not saved in place — use Open to find it`, 'error');
        return;
      }
      try {
        const opened = await files.reopen(entry.handle);
        if (!opened) { notify('Permission to read the file was not granted', 'error'); return; }
        await takeFile(opened);
      } catch (e) {
        // The file has moved or gone; the entry is now a lie, so drop it.
        await forgetRecent(store, entry.name);
        setRecents(await listRecents(store));
        notify(`Could not reopen ${entry.name}: ${e instanceof Error ? e.message : String(e)}`, 'error');
      }
    };
    openRecentRef.current = openRecent;

    const host = createHost({
      doc, viewer,
      terminalFeature: () => terminalFeature(doc),
      captureRefs: (feature, kind, indices) =>
        captureRefs(kernel, feature, kind, indices, (id) => handles.get(id) ?? null),
      rebuild: doRebuild,
      // ---------------------------------------------------------------- files
      newDocument: async () => {
        if (!(await confirmDiscard())) return;
        loadStarter(doc);
        fileRef.current = { handle: null, savedRevision: doc.revision };
        syncFileState();
        await doRebuild();
        viewer.fitAll();
      },

      openDocument: async () => {
        if (!(await confirmDiscard())) return;
        let opened: OpenedFile | null;
        try {
          opened = await files.open();
        } catch (e) {
          notify(e instanceof Error ? e.message : String(e), 'error');
          return;
        }
        if (opened) await takeFile(opened);
      },

      saveDocument: async () => {
        const { handle } = fileRef.current;
        if (!handle || !files.canOverwrite) { await host.saveDocumentAs(); return; }
        try {
          await files.save(handle, snapshotForSave());
          markSaved(doc.meta.name);
          notify(`Saved ${doc.meta.name}`);
        } catch (e) {
          notify(`Save failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
        }
      },

      saveDocumentAs: async () => {
        try {
          const saved = await files.saveAs(doc.meta.name || 'part', snapshotForSave());
          if (!saved) return;
          doc.rename(saved.name);
          fileRef.current.handle = saved.handle;
          markSaved(saved.name);
          await remember(saved.name, saved.handle);
          notify(files.canOverwrite ? `Saved ${saved.name}` : `Downloaded ${saved.name}.card`);
        } catch (e) {
          notify(`Save failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
        }
      },

      openExport: () => {
        setExportScope(viewer.selection.selected.some((r) => r.kind === 'body') ? 'selected' : 'all');
        setExportStats(null);
        setExportOpen(true);
      },

      toggleAnalysis: (mode) => {
        viewer.setAnalysis(viewer.analysis === mode ? 'none' : mode);
        if (viewer.analysis === 'thickness') {
          const thinnest = viewer.minThickness();
          if (thinnest !== null) {
            const limit = printerRef.current.profile.nozzle * 2;
            notify(thinnest < limit
              ? `Thinnest wall ${thinnest.toFixed(2)} mm — under two perimeters (${limit.toFixed(1)} mm)`
              : `Thinnest wall ${thinnest.toFixed(2)} mm`);
          }
        }
        repaint();
      },
      toggleBuildVolume: () => {
        buildVolumeRef.current = !buildVolumeRef.current;
        viewer.showBuildVolume(buildVolumeRef.current);
        repaint();
      },
      openOrientations: () => {
        setOrientRows(null);
        setOrientOpen(true);
        void exportRef.current.orientations().then(setOrientRows).catch((e: unknown) => {
          setOrientRows([]);
          notify(`Could not score orientations: ${e instanceof Error ? e.message : String(e)}`, 'error');
        });
      },
      openPrinterSettings: () => setPrinterOpen(true),

      importModel: async () => {
        let picked: Awaited<ReturnType<FileAccess['pickImport']>>;
        try {
          picked = await files.pickImport(Object.keys(IMPORT_EXTENSIONS));
        } catch (e) {
          notify(e instanceof Error ? e.message : String(e), 'error');
          return;
        }
        if (!picked) return;
        const extension = picked.name.slice(picked.name.lastIndexOf('.')).toLowerCase();
        const format = IMPORT_EXTENSIONS[extension];
        if (!format) { notify(`${picked.name}: only STEP and STL can be imported`, 'error'); return; }
        // The file's contents live in the feature, so the part stays self-contained.
        const data = format === 'step'
          ? new TextDecoder().decode(picked.bytes)
          : bytesToBase64(picked.bytes);
        const id = doc.newFeatureId('import');
        doc.addFeature({
          id, type: 'import', name: picked.name.slice(0, -extension.length),
          values: { format, data, file: picked.name }, inputs: {},
        });
        setFocused(id);
        await doRebuild();
        viewer.fitAll();
        const state = doc.engine.lastStates?.get(id);
        if (state?.status === 'error') notify(`Import failed: ${state.message ?? 'unknown error'}`, 'error');
        else notify(`Imported ${picked.name}`);
      },
      openPalette: () => setPaletteOpen(true),
      openAbout: () => setAboutOpen(true),
      openKeys: () => setKeysOpen(true),
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

      applySketchConstraint: (type) => {
        const session = sessionRef.current;
        if (!session) return 'Open a sketch first';
        const reason = applyConstraint(
          session.sketch, type as ApplicableConstraint, session.selected,
        );
        if (reason) { notify(reason, 'error'); return reason; }
        // The tools mutate the Sketch directly, so the graph has to be told, and the
        // solver only re-runs on a rebuild.
        session.selected.clear();
        session.refresh();
        doc.markSketchChanged(session.featureId);
        syncSketch();
        void doRebuild();
        return null;
      },

      sketchConstraintBlocker: (type) => {
        const session = sessionRef.current;
        if (!session) return 'Open a sketch first';
        const result = constraintFromSelection(
          session.sketch, type as ApplicableConstraint, session.selected,
        );
        return result.ok ? null : result.reason;
      },

      setSketchTool: (tool) => { sessionRef.current?.setTool(tool); syncSketch(); },
      sketching: () => sessionRef.current !== null,
      sketchTool: () => sessionRef.current?.tools.kind ?? null,
      sketchSelectionCount: () => sessionRef.current?.selected.size ?? 0,
      analysis: () => viewer.analysis,
      buildVolume: () => buildVolumeRef.current,

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

    let stopAutosave: (() => void) | undefined;
    let stopDirtyWatch: (() => void) | undefined;
    let stopOpenRequests: (() => void) | null = null;
    void (async () => {
      await kernel.whenReady();
      setReady(true);
      files = await defaultFileAccess();

      // Unsaved work from last time comes back by itself; that is what an autosave is
      // for. `?fresh` skips it, for a clean slate and for the verification harness.
      const fresh = new URLSearchParams(window.location.search).has('fresh');
      const recovered = fresh ? null : await readAutosave(store).catch(() => null);
      // A file the desktop shell was launched with outranks both: the double-click IS
      // the instruction. Requests that arrive while running go through the discard prompt.
      const launched = await files.launchFile?.();
      stopOpenRequests = files.onOpenRequest?.((opened) => {
        void confirmDiscard().then((ok) => { if (ok) return takeFile(opened); });
      }) ?? null;
      if (launched) {
        await takeFile(launched);
      } else if (recovered && recovered.file.features.length > 0) {
        try {
          doc.load(recovered.file);
          notify(`Restored unsaved work from ${new Date(recovered.savedAt).toLocaleTimeString()}`);
        } catch {
          loadStarter(doc);
        }
      } else {
        loadStarter(doc);
      }
      if (!launched) {
        // Whatever we booted into is the baseline: it is not "unsaved" until it changes.
        fileRef.current = { handle: null, savedRevision: doc.revision };
        syncFileState();
        await doRebuild();
        const saved = doc.meta.camera;
        if (recovered && saved) {
          Object.assign(viewer.controller.target, {
            azimuth: saved.azimuth, elevation: saved.elevation, zoom: saved.zoom,
          });
          Object.assign(viewer.controller.target.pivot, saved.pivot);
        } else {
          viewer.fitAll();
        }
        viewer.controller.settle();
      }
      setRecents(await listRecents(store).catch(() => []));

      stopAutosave = startAutosave(doc, store, (message) => notify(message, 'error'), snapshotForSave);
      stopDirtyWatch = doc.subscribe(() => syncFileState());
    })();

    // ---------------------------------------------------------------- export
    /** The shape to export: one body, or a compound of several. Compounds are
     *  temporary and must be released, or every export leaks a kernel shape. */
    const exportShape = async (scope: 'all' | 'selected') => {
      const chosen = scope === 'selected'
        ? [...new Set(viewer.selection.selected.filter((r) => r.kind === 'body').map((r) => r.bodyId as unknown as FeatureId))]
        : bodyFeatures(doc);
      const bodies = chosen.map((id) => handles.get(id)).filter((h): h is string => h !== undefined);
      if (bodies.length === 0) return null;
      if (bodies.length === 1) return { handle: bodies[0] as ShapeHandle, count: 1, release: () => {} };
      const { handle } = await kernel.compound(bodies as ShapeHandle[]);
      return { handle, count: bodies.length, release: () => { void kernel.release(handle); } };
    };
    const toKernelQuality = (q: ExportQuality) => ({
      linearDeflection: q.linear, angularDeflection: (q.angular * Math.PI) / 180,
    });
    exportRef.current = {
      stats: async (quality, scope) => {
        const shape = await exportShape(scope);
        if (!shape) return null;
        try {
          return await kernel.meshStats(shape.handle, toKernelQuality(quality));
        } finally { shape.release(); }
      },
      write: async (format, quality, scope, orientation) => {
        const shape = await exportShape(scope);
        if (!shape) { notify('Nothing to export', 'error'); return; }
        const spec = EXPORT_FORMATS[format];
        const name = doc.meta.name || 'part';
        let oriented: { handle: ShapeHandle; release: () => void } | null = null;
        try {
          if (orientation) {
            const { handle } = await kernel.transform(shape.handle, orientation.matrix);
            oriented = { handle, release: () => { void kernel.release(handle); } };
          }
          const result = await kernel.exportModel((oriented ?? shape).handle, format, {
            quality: toKernelQuality(quality), name,
          });
          const written = await files.exportBytes(`${name}${spec.extension}`, result.bytes, spec.mime);
          if (!written) return;
          const size = `${(result.bytes.length / 1024).toFixed(0)} kB`;
          notify(
            result.triangles > 0
              ? `Exported ${spec.label}: ${result.triangles.toLocaleString()} triangles, ${size}`
              : `Exported ${spec.label}: ${size}`,
          );
          setExportOpen(false);
        } catch (e) {
          notify(`Export failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
        } finally { oriented?.release(); shape.release(); }
      },
      orientations: async () => {
        const shape = await exportShape('all');
        if (!shape) return [];
        try {
          return await kernel.scoreOrientations(shape.handle, {
            maxOverhangDeg: printerRef.current.profile.maxOverhang, layer: printerRef.current.profile.layer,
          });
        } finally { shape.release(); }
      },
    };

    // ---------------------------------------------------------------- printer
    printerRef.current = {
      profile: DEFAULT_PRINTER,
      apply: async (profile, rebuildToo) => {
        printerRef.current.profile = profile;
        setPrinter(profile);
        doc.parameters.setEnvironment(profileEnvironment(profile));
        viewer.setPrintLimits({
          maxOverhangDeg: profile.maxOverhang, layer: profile.layer, nozzle: profile.nozzle, bed: profile.bed,
        });
        if (rebuildToo) {
          // `nozzle` may be in an expression somewhere; nothing tracks that, so everything
          // is dirtied. Printer changes are rare and a full rebuild is cheap.
          doc.invalidateAll();
          await doRebuild();
        }
      },
    };
    void store.get<unknown>('printer').then((raw) => printerRef.current.apply(normaliseProfile(raw), false)).catch(() => {});

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

    return () => {
      stopAutosave?.();
      stopDirtyWatch?.();
      stopOpenRequests?.();
      teardown();
    };
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
        sketchSelectionCount: 0, analysis: 'none', buildVolume: false,
      };
    }
    return {
      selectionKind: c.viewer.selection.selected[0]?.kind ?? null,
      selectionCount: c.viewer.selection.selected.length,
      hoverKind: c.viewer.selection.hover?.kind ?? null,
      hasModel: c.viewer.bodies.size > 0,
      featureCount: c.doc.features.length,
      bodyCount: bodyFeatures(c.doc).length,
      canUndo: c.doc.canUndo,
      canRedo: c.doc.canRedo,
      busy: c.busy,
      focusedFeature: focusedRef.current,
      sketching: sessionRef.current !== null,
      sketchTool: sessionRef.current?.tools.kind ?? null,
      sketchSelectionCount: sessionRef.current?.selected.size ?? 0,
      analysis: c.viewer.analysis,
      buildVolume: buildVolumeRef.current,
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
    // Indented under what each feature was built FROM: an extrude under its sketch, a
    // fillet under the extrude. The list stays in history order — that is what reorder
    // acts on — so the indent is the only thing that says which chain a row belongs to.
    // Optional inputs (a sketch naming the face it sits on) do not count: the sketch
    // starts a new object, and nesting it under the plate would say they are one body
    // when Combine, correctly, says they are not.
    const depths = new Map<string, number>();
    for (const feature of doc.features) {
      const definition = doc.registry.get(feature.type);
      const role = definition?.primaryInput ?? definition?.shapeInputs[0];
      const parent = role ? feature.inputs[role] : undefined;
      depths.set(feature.id, parent && depths.has(parent) ? depths.get(parent)! + 1 : 0);
    }
    return doc.features.map((feature) => {
      const featureState = states?.get(feature.id);
      return {
        id: feature.id,
        name: feature.name,
        type: feature.type,
        depth: depths.get(feature.id) ?? 0,
        status: featureState?.status ?? 'blocked',
        ...(featureState?.message ? { message: featureState.message } : {}),
      };
    });
  }, [doc, report]);

  const focusedFeature = focused && doc ? doc.feature(focused) : null;

  useEffect(() => {
    document.title = `${fileState.dirty ? '• ' : ''}${fileState.name} — CARDstock`;
  }, [fileState]);

  // The live triangle count. Debounced so typing a deviation digit by digit does not
  // queue a tessellation per keystroke; stale answers are dropped by generation.
  const statsGeneration = useRef(0);
  useEffect(() => {
    if (!exportOpen || !EXPORT_FORMATS[exportFormat].mesh) return;
    const generation = ++statsGeneration.current;
    setExportStats(null);
    const timer = setTimeout(() => {
      void exportRef.current.stats(exportQuality, exportScope).then((stats) => {
        if (generation === statsGeneration.current) setExportStats(stats);
      }).catch(() => { if (generation === statsGeneration.current) setExportStats(null); });
    }, 250);
    return () => clearTimeout(timer);
  }, [exportOpen, exportFormat, exportQuality, exportScope]);
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
    // Undeclared keys are plain settings the definition reads directly — an import's
    // file contents, say — not dimensions, so they only surface for an unknown type.
    const keys = focusedDefinition ? declared : Object.keys(values);
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
  /**
   * Document parameters, filtered to the ones the focused feature actually uses.
   *
   * Parameters are document-wide, but listing all of them under every feature reads as
   * though they belong to it: the starter plate's `width` sat under PARAMETERS while a
   * hole was focused, which says the hole has a width. With nothing focused the panel is
   * the DOCUMENT view, so it lists them all and they stay reachable.
   */
  const parameters: FieldSpec[] = (() => {
    if (!doc) return [];
    const all = doc.parameters.all();
    if (!focusedFeature) {
      return all.map((p) => ({ key: p.name, label: p.name, value: p.expression }));
    }
    const expressions = Object.values(focusedFeature.values).join(' ');
    return all
      // Word-boundary match, so `width` is not found inside `widthwise`.
      .filter((p) => new RegExp(`\\b${p.name}\\b`).test(expressions))
      .map((p) => ({ key: p.name, label: p.name, value: p.expression }));
  })();

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
            onContextMenu={(id, at) => { setFocused(id); setTreeMenuAt({ top: at.y, left: at.x }); }}
            onReorder={(id, toIndex) => {
              const result = doc.moveFeature(id, toIndex);
              if (!result.ok) setNotice({ text: result.reason ?? 'Cannot move there', kind: 'error' });
              else rebuildNow();
            }}
          />
          <ParameterPanel
            title={focusedFeature?.name || `${fileState.name}${fileState.dirty ? ' •' : ''}`}
            {...(focusedFeature
              ? { subtitle: focusedFeature.values.file
                  ? `${focusedFeature.type} · ${focusedFeature.values.file}`
                  : focusedFeature.type }
              : { subtitle: fileState.dirty ? 'unsaved changes' : 'saved' })}
            {...(!focusedFeature && recents.length > 0 ? {
              footer: (
                <div className="recents">
                  <div className="panel-section-title">Recent</div>
                  {recents.map((entry) => (
                    <button
                      key={entry.name}
                      type="button"
                      className="recent"
                      title={entry.handle
                        ? `Reopen ${entry.name}`
                        : `${entry.name} was downloaded; use Open to find it`}
                      onClick={() => { void openRecentRef.current(entry); }}
                    >
                      {entry.thumbnail
                        ? <img className="recent-thumb" src={entry.thumbnail} alt="" />
                        : <span className="recent-thumb recent-thumb-empty" />}
                      <span className="recent-name">{entry.name}</span>
                    </button>
                  ))}
                </div>
              ),
            } : {})}
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
        {...(estimates ? {
          print: `${estimates.cm3.toFixed(1)} cm³ · ${estimates.grams.toFixed(0)} g · ${estimates.metres.toFixed(1)} m solid`,
        } : {})}
        {...(!printFit ? { warning: `Does not fit the ${printer.bed.x}×${printer.bed.y}×${printer.bed.z} bed` } : {})}
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

      {treeMenuAt && registry && (
        <>
          {/* A scrim so a click anywhere else closes it; the flyout stops propagation. */}
          <div
            className="flyout-scrim"
            onPointerDown={() => setTreeMenuAt(null)}
            onContextMenu={(e) => { e.preventDefault(); setTreeMenuAt(null); }}
          />
          <Submenu
            items={registry.forContext('tree-item', hostState())}
            anchor={treeMenuAt}
            title={focusedFeature?.name ?? 'Feature'}
            onRun={(id) => { run(id); setTreeMenuAt(null); }}
          />
        </>
      )}

      {constraintsAt && registry && (
        <Submenu
          items={registry.childrenOf('sketch.constrain', hostState())}
          anchor={constraintsAt}
          title="Constrain"
          onRun={(id) => { run(id); setConstraintsAt(null); }}
          onLeave={() => setConstraintsAt(null)}
        />
      )}

      {aboutOpen && (
        <AboutDialog info={BUILD} author="Rutledge Dixon" onClose={() => setAboutOpen(false)} />
      )}

      {keysOpen && registry && (
        <KeysDialog
          commands={registry.all()
            .filter((c) => c.keys && c.keys.length > 0)
            .map((c) => ({
              keys: (c.keys ?? []).map((k) => (k === 'shift+?' ? '?' : k)),
              title: c.title, ...(c.hint ? { hint: c.hint } : {}),
            }))}
          onClose={() => setKeysOpen(false)}
        />
      )}

      {printerOpen && (
        <PrinterDialog
          printer={printer}
          onSave={(fields) => {
            const profile = normaliseProfile(fields);
            setPrinterOpen(false);
            void printerRef.current.apply(profile, true);
            void defaultStore().set('printer', profile).catch(() => {});
            setExportOrientation(null);
          }}
          onClose={() => setPrinterOpen(false)}
        />
      )}

      {orientOpen && (
        <OrientationDialog
          rows={orientRows as OrientationRow[] | null}
          applied={exportOrientation?.index ?? null}
          onApply={(index) => {
            const suggestion = orientRows?.[index];
            if (suggestion) setExportOrientation({ index, suggestion });
          }}
          onClear={() => setExportOrientation(null)}
          onClose={() => setOrientOpen(false)}
        />
      )}

      {exportOpen && (
        <ExportDialog
          formats={Object.entries(EXPORT_FORMATS).map(([id, f]) => ({ id, label: f.label, mesh: f.mesh }))}
          format={exportFormat}
          onFormat={(id) => setExportFormat(id as ExportFormat)}
          quality={exportQuality}
          onQuality={setExportQuality}
          scope={exportScope}
          onScope={setExportScope}
          bodyCount={doc ? bodyFeatures(doc).length : 0}
          selectedCount={new Set(
            (core.current?.viewer.selection.selected ?? []).filter((r) => r.kind === 'body').map((r) => r.bodyId),
          ).size}
          stats={exportStats}
          fileName={`${fileState.name}${EXPORT_FORMATS[exportFormat].extension}`}
          busy={exportBusy}
          orientation={exportOrientation ? describeDown(exportOrientation.suggestion.down) : null}
          onClearOrientation={() => setExportOrientation(null)}
          onExport={() => {
            setExportBusy(true);
            void exportRef.current.write(exportFormat, exportQuality, exportScope, exportOrientation?.suggestion ?? null)
              .finally(() => setExportBusy(false));
          }}
          onClose={() => setExportOpen(false)}
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

          {/* What the active tool wants next. The dimension tool in particular gives no
              clue on its own — the button turns on and nothing appears to happen. */}
          {TOOL_HINTS[sketchInfo.tool] && (
            <span className="sketchbar-hint">{TOOL_HINTS[sketchInfo.tool]}</span>
          )}

          {/* Constraints, behind ONE level of submenu. Each entry carries the selection
              it wants, so a disabled one teaches instead of dead-ending. */}
          <span className="sketchbar-constraints">
            <button
              type="button"
              className={constraintsAt ? 'is-open' : ''}
              data-command="sketch.constrain"
              aria-haspopup="true"
              aria-expanded={constraintsAt !== null}
              title="Constrain the selected geometry"
              onClick={(e) => {
                if (constraintsAt) { setConstraintsAt(null); return; }
                const box = e.currentTarget.getBoundingClientRect();
                setConstraintsAt({ top: box.bottom + 6, left: box.left });
              }}
            >
              ⌗ Constrain
            </button>
          </span>

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
      void reportPrintFacts(c, generation);
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

  /**
   * What the printer will make of it: does it fit the bed, and what will it weigh.
   *
   * Runs after every rebuild, off the critical path; a superseded run's answer is
   * dropped so a stale volume never lands on a newer model.
   */
  async function reportPrintFacts(c: NonNullable<typeof core.current>, generation: number): Promise<void> {
    const bounds = c.viewer.bounds();
    const profile = printerRef.current.profile;
    const fits = bounds
      ? fitsBed({
          x: bounds.max.x - bounds.min.x, y: bounds.max.y - bounds.min.y, z: bounds.max.z - bounds.min.z,
        }, profile)
      : true;
    c.viewer.setBuildVolumeFits(fits);
    setPrintFit(fits);

    let volume = 0;
    try {
      for (const id of bodyFeatures(c.doc)) {
        const handle = c.handles.get(id);
        if (handle) volume += (await c.kernel.massProperties(handle as ShapeHandle)).volume;
      }
    } catch { return; }
    if (rebuildGeneration.current !== generation) return;
    setEstimates(volume > 0 ? printEstimates(volume, profile) : null);
  }
}

/**
 * The starter part: a plate to build from.
 *
 * What a fresh boot and New both give you. An empty viewport teaches nothing, and a plate
 * is the first thing most printed parts begin as anyway.
 */
function loadStarter(doc: Document): void {
  doc.load({
    schemaVersion: 2,
    meta: {
      name: 'Untitled', units: 'mm', application: 'CARDstock',
      created: new Date().toISOString(), modified: new Date().toISOString(),
    },
    parameters: [{ name: 'width', expression: '60', unit: 'mm' }],
    features: [{
      id: 'plate', type: 'box', name: 'Plate',
      values: { dx: 'width', dy: '40', dz: '18' }, inputs: {},
    }],
    sketches: {},
  });
}

/** What each tool is waiting for. Shown in the sketch bar while that tool is active. */
const TOOL_HINTS: Record<string, string> = {
  line: 'Click each point; click the first again to close',
  rectangle: 'Click two opposite corners',
  circle: 'Click the centre, then the rim',
  dimension: 'Click two points for a length, or a circle for its radius',
  select: 'Click geometry to select; shift-click to add',
};

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
