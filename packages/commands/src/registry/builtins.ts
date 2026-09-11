import type { Command, CommandState } from './command.js';
import type { CommandHost } from './host.js';

/**
 * The command set.
 *
 * Sectors are assigned once, here, and never move. Feature *variants* live in the
 * feature's parameter panel — a boolean's union/cut/intersect is a field, not three
 * toolbar buttons and not a submenu.
 */

const needsSelection = (kind: 'face' | 'edge' | 'body', what: string) =>
  (state: CommandState) =>
    state.selectionKind === kind && state.selectionCount > 0
      ? true
      : `Select ${what} first`;

const needsModel = (state: CommandState) =>
  state.hasModel ? true : 'Nothing in the model yet';

/**
 * Two bodies, and not mid-sketch.
 *
 * The old message said "Needs two separate bodies" whatever the reason, which is
 * unhelpful precisely when the user believes they HAVE selected two — the count is of
 * bodies in the MODEL, not of what is selected. It now names which problem it is.
 */
const combineEnabled = (state: CommandState): true | string => {
  if (state.sketching) return 'Finish the sketch first';
  if (state.bodyCount < 2) {
    return state.bodyCount === 1
      ? 'Only one body — make a second to combine with'
      : 'Nothing to combine yet';
  }
  return true;
};

export function createBuiltinCommands(host: CommandHost): Command[] {
  return [
    // ---------------------------------------------------------------- sketching
    {
      id: 'sketch.new',
      title: 'Sketch',
      hint: 'Start a sketch on a plane',
      icon: '✎',
      contexts: ['face', 'empty'],
      sector: { face: 0 },
      toolbar: { order: 10 },
      // N for "new sketch". S and D went to the camera when WASD was added; a key that
      // orbits the model everywhere except inside one command is worse than a rebind.
      keys: ['n'],
      children: ['sketch.onFace', 'sketch.onXY', 'sketch.onXZ', 'sketch.onYZ'],
      enabled: (s) => (s.sketching ? 'Already sketching' : true),
      run: () => {},
    },
    {
      id: 'sketch.onFace',
      title: 'On selected face',
      hint: 'Sketch on the face you have selected',
      icon: '◧',
      contexts: ['face'],
      enabled: (s) => {
        if (s.sketching) return 'Already sketching';
        return s.selectionKind === 'face' && s.selectionCount > 0
          ? true
          : 'Select a flat face first';
      },
      run: async () => { await host.beginSketchOnFace(); },
    },
    {
      id: 'sketch.onXY',
      title: 'Top (XY)',
      hint: 'Sketch on the ground plane',
      icon: '▤',
      contexts: ['empty'],
      enabled: (s) => (s.sketching ? 'Already sketching' : true),
      run: async () => { await host.beginSketch('xy'); },
    },
    {
      id: 'sketch.onXZ',
      title: 'Front (XZ)',
      icon: '▥',
      contexts: ['empty'],
      enabled: (s) => (s.sketching ? 'Already sketching' : true),
      run: async () => { await host.beginSketch('xz'); },
    },
    {
      id: 'sketch.onYZ',
      title: 'Side (YZ)',
      icon: '▧',
      contexts: ['empty'],
      enabled: (s) => (s.sketching ? 'Already sketching' : true),
      run: async () => { await host.beginSketch('yz'); },
    },

    // ---------------------------------------------------------------- sketch tools
    {
      id: 'sketch.line',
      title: 'Line',
      hint: 'Draw connected lines; click the start again to close',
      icon: '╱',
      contexts: ['sketch'],
      sector: { sketch: 0 },
      keys: ['l'],
      enabled: (s) => (s.sketching ? true : 'Open a sketch first'),
      run: () => host.setSketchTool('line'),
    },
    {
      id: 'sketch.rectangle',
      title: 'Rectangle',
      icon: '▭',
      contexts: ['sketch'],
      sector: { sketch: 2 },
      keys: ['r'],
      enabled: (s) => (s.sketching ? true : 'Open a sketch first'),
      run: () => host.setSketchTool('rectangle'),
    },
    {
      id: 'sketch.circle',
      title: 'Circle',
      icon: '○',
      contexts: ['sketch'],
      sector: { sketch: 4 },
      keys: ['o'],
      enabled: (s) => (s.sketching ? true : 'Open a sketch first'),
      run: () => host.setSketchTool('circle'),
    },
    {
      id: 'sketch.select',
      title: 'Select',
      icon: '⬉',
      contexts: ['sketch'],
      sector: { sketch: 6 },
      enabled: (s) => (s.sketching ? true : 'Open a sketch first'),
      run: () => host.setSketchTool('select'),
    },
    {
      id: 'sketch.dimension',
      title: 'Dimension',
      hint: 'Pin a length or radius; click two points, or a circle',
      icon: '↔',
      contexts: ['sketch'],
      sector: { sketch: 1 },
      // M for measure: D orbits the camera now.
      keys: ['m'],
      enabled: (s) => (s.sketching ? true : 'Open a sketch first'),
      run: () => host.setSketchTool('dimension'),
    },
    {
      id: 'sketch.constrain',
      title: 'Constrain',
      hint: 'Pin the sketch down: parallel, perpendicular, equal, tangent…',
      icon: '⌗',
      contexts: ['sketch'],
      sector: { sketch: 3 },
      children: ['constrain.coincident', 'constrain.horizontal', 'constrain.vertical', 'constrain.parallel', 'constrain.perpendicular', 'constrain.tangent', 'constrain.equal', 'constrain.concentric', 'constrain.pointOnLine', 'constrain.symmetric', 'constrain.fix'],
      enabled: (s) => (s.sketching
        ? (s.sketchSelectionCount > 0 ? true : 'Select sketch geometry first')
        : 'Open a sketch first'),
      run: () => {},
    },
    {
      id: 'constrain.coincident',
      title: 'Coincident',
      hint: 'Join two points',
      icon: '⌖',
      contexts: ['sketch'],
      enabled: (s) => (s.sketching
        ? (host.sketchConstraintBlocker('coincident') ?? true)
        : 'Open a sketch first'),
      run: () => { host.applySketchConstraint('coincident'); },
    },
    {
      id: 'constrain.horizontal',
      title: 'Horizontal',
      hint: 'Level a line',
      icon: '―',
      contexts: ['sketch'],
      enabled: (s) => (s.sketching
        ? (host.sketchConstraintBlocker('horizontal') ?? true)
        : 'Open a sketch first'),
      run: () => { host.applySketchConstraint('horizontal'); },
    },
    {
      id: 'constrain.vertical',
      title: 'Vertical',
      hint: 'Stand a line upright',
      icon: '│',
      contexts: ['sketch'],
      enabled: (s) => (s.sketching
        ? (host.sketchConstraintBlocker('vertical') ?? true)
        : 'Open a sketch first'),
      run: () => { host.applySketchConstraint('vertical'); },
    },
    {
      id: 'constrain.parallel',
      title: 'Parallel',
      hint: 'Keep two lines parallel',
      icon: '∥',
      contexts: ['sketch'],
      enabled: (s) => (s.sketching
        ? (host.sketchConstraintBlocker('parallel') ?? true)
        : 'Open a sketch first'),
      run: () => { host.applySketchConstraint('parallel'); },
    },
    {
      id: 'constrain.perpendicular',
      title: 'Perpendicular',
      hint: 'Hold two lines at a right angle',
      icon: '⊥',
      contexts: ['sketch'],
      enabled: (s) => (s.sketching
        ? (host.sketchConstraintBlocker('perpendicular') ?? true)
        : 'Open a sketch first'),
      run: () => { host.applySketchConstraint('perpendicular'); },
    },
    {
      id: 'constrain.tangent',
      title: 'Tangent',
      hint: 'Meet a circle smoothly',
      icon: '◟',
      contexts: ['sketch'],
      enabled: (s) => (s.sketching
        ? (host.sketchConstraintBlocker('tangent') ?? true)
        : 'Open a sketch first'),
      run: () => { host.applySketchConstraint('tangent'); },
    },
    {
      id: 'constrain.equal',
      title: 'Equal',
      hint: 'Same length, or same radius',
      icon: '=',
      contexts: ['sketch'],
      enabled: (s) => (s.sketching
        ? (host.sketchConstraintBlocker('equal') ?? true)
        : 'Open a sketch first'),
      run: () => { host.applySketchConstraint('equal'); },
    },
    {
      id: 'constrain.concentric',
      title: 'Concentric',
      hint: 'Share a centre',
      icon: '◎',
      contexts: ['sketch'],
      enabled: (s) => (s.sketching
        ? (host.sketchConstraintBlocker('concentric') ?? true)
        : 'Open a sketch first'),
      run: () => { host.applySketchConstraint('concentric'); },
    },
    {
      id: 'constrain.pointOnLine',
      title: 'Point on line',
      hint: 'Hold a point on a line',
      icon: '⋅',
      contexts: ['sketch'],
      enabled: (s) => (s.sketching
        ? (host.sketchConstraintBlocker('pointOnLine') ?? true)
        : 'Open a sketch first'),
      run: () => { host.applySketchConstraint('pointOnLine'); },
    },
    {
      id: 'constrain.symmetric',
      title: 'Symmetric',
      hint: 'Mirror two points about a line',
      icon: '⇔',
      contexts: ['sketch'],
      enabled: (s) => (s.sketching
        ? (host.sketchConstraintBlocker('symmetric') ?? true)
        : 'Open a sketch first'),
      run: () => { host.applySketchConstraint('symmetric'); },
    },
    {
      id: 'constrain.fix',
      title: 'Fix in place',
      hint: 'Pin a point where it is',
      icon: '⚓',
      contexts: ['sketch'],
      enabled: (s) => (s.sketching
        ? (host.sketchConstraintBlocker('fix') ?? true)
        : 'Open a sketch first'),
      run: () => { host.applySketchConstraint('fix'); },
    },
    {
      id: 'sketch.finish',
      title: 'Finish sketch',
      hint: 'Close the sketch and return to the model',
      icon: '✓',
      contexts: ['sketch', 'always'],
      enabled: (s) => (s.sketching ? true : 'No sketch is open'),
      run: async () => { await host.finishSketch(); },
    },
    {
      id: 'sketch.edit',
      title: 'Edit sketch',
      hint: 'Reopen this sketch for editing',
      icon: '✐',
      contexts: ['tree-item'],
      sector: { 'tree-item': 4 },
      enabled: (s) => {
        if (s.sketching) return 'Finish the current sketch first';
        return s.focusedFeature ? true : 'Select a sketch in the tree';
      },
      run: async () => { await host.editSketch(); },
    },
    {
      id: 'build.solid',
      title: 'Build',
      hint: 'Turn a sketch into a solid',
      icon: '⬒',
      contexts: ['always'],
      toolbar: { order: 11 },
      children: ['sketch.extrude', 'build.revolve', 'build.sweep', 'build.loft'],
      enabled: (s) => (s.sketching ? 'Finish the sketch first' : true),
      run: () => {},
    },
    {
      id: 'sketch.extrude',
      title: 'Extrude',
      hint: 'Sweep the sketch straight out',
      icon: '⬒',
      contexts: ['always'],
      keys: ['e'],
      enabled: (s) => (s.sketching ? 'Finish the sketch first' : true),
      run: async () => { await host.extrudeSketch(); },
    },
    {
      id: 'build.revolve',
      title: 'Revolve',
      hint: 'Spin the sketch around an axis',
      icon: '↻',
      contexts: ['always'],
      enabled: (s) => (s.sketching ? 'Finish the sketch first' : true),
      run: async () => { await host.addSolidFeature('revolve'); },
    },
    {
      id: 'build.sweep',
      title: 'Sweep',
      hint: 'Run the sketch along a path drawn as a second sketch',
      icon: '⤳',
      contexts: ['always'],
      enabled: (s) => (s.sketching ? 'Finish the sketch first'
        : s.featureCount >= 2 ? true : 'Draw a profile and a path first'),
      run: async () => { await host.addSolidFeature('sweep'); },
    },
    {
      id: 'build.loft',
      title: 'Loft',
      hint: 'Blend two or more sketches into one solid',
      icon: '⧗',
      contexts: ['always'],
      enabled: (s) => (s.sketching ? 'Finish the sketch first'
        : s.featureCount >= 2 ? true : 'Draw at least two sections first'),
      run: async () => { await host.addSolidFeature('loft'); },
    },

    // ---------------------------------------------------------------- primitives
    {
      id: 'create.shape',
      title: 'New shape',
      hint: 'Add a box, cylinder or sphere',
      icon: '◇',
      contexts: ['empty', 'always'],
      sector: { empty: 0 },
      toolbar: { order: 20 },
      children: ['primitive.box', 'primitive.cylinder', 'primitive.sphere'],
      enabled: () => true,
      run: () => {}, // a group: opening the flyout is the action
    },
    {
      id: 'primitive.box',
      title: 'Box',
      hint: 'Add a box',
      icon: '▣',
      contexts: ['empty', 'always'],
      enabled: () => true,
      run: async () => { await host.addPrimitive('box'); },
    },
    {
      id: 'primitive.cylinder',
      title: 'Cylinder',
      hint: 'Add a cylinder',
      icon: '⬭',
      contexts: ['empty', 'always'],
      enabled: () => true,
      run: async () => { await host.addPrimitive('cylinder'); },
    },
    {
      id: 'primitive.sphere',
      title: 'Sphere',
      hint: 'Add a sphere',
      icon: '●',
      contexts: ['empty', 'always'],
      enabled: () => true,
      run: async () => { await host.addPrimitive('sphere'); },
    },

    // ---------------------------------------------------------------- modify
    {
      id: 'modify.edge',
      title: 'Modify edge',
      hint: 'Fillet or chamfer the selected edges',
      icon: '◟',
      contexts: ['edge'],
      sector: { edge: 0 },
      toolbar: { order: 30 },
      children: ['modify.fillet', 'modify.chamfer'],
      enabled: needsSelection('edge', 'one or more edges'),
      run: () => {},
    },
    {
      id: 'modify.fillet',
      title: 'Fillet',
      hint: 'Round the selected edges',
      icon: '◜',
      contexts: ['edge'],
      // Fit owns plain F: it is the far more frequent action, and it is what the status
      // bar has advertised since Phase 1.
      keys: ['shift+f'],
      enabled: needsSelection('edge', 'one or more edges'),
      run: async () => { await host.addEdgeOperation('fillet'); },
    },
    {
      id: 'modify.chamfer',
      title: 'Chamfer',
      hint: 'Bevel the selected edges',
      icon: '◹',
      contexts: ['edge'],
      keys: ['c'],
      enabled: needsSelection('edge', 'one or more edges'),
      run: async () => { await host.addEdgeOperation('chamfer'); },
    },
    {
      id: 'modify.body',
      title: 'Modify',
      hint: 'Hollow, mirror or move the body',
      icon: '◫',
      // Also on 'face': shell and draft both act on picked faces, and right-clicking the
      // face you want to open is the natural way to reach them.
      contexts: ['body', 'face', 'always'],
      sector: { body: 0, face: 4 },
      toolbar: { order: 31 },
      children: ['modify.shell', 'modify.draft', 'modify.mirror', 'modify.move'],
      enabled: needsModel,
      run: () => {},
    },
    {
      id: 'modify.shell',
      title: 'Shell',
      hint: 'Hollow the body, opening the selected faces',
      icon: '⌷',
      contexts: ['face'],
      enabled: (s) => (s.selectionKind === 'face' && s.selectionCount > 0
        ? true : 'Select the faces to open'),
      run: async () => { await host.addSolidFeature('shell'); },
    },
    {
      id: 'modify.draft',
      title: 'Draft',
      hint: 'Taper the selected faces away from the plate',
      icon: '◺',
      contexts: ['face'],
      enabled: (s) => (s.selectionKind === 'face' && s.selectionCount > 0
        ? true : 'Select the faces to taper'),
      run: async () => { await host.addSolidFeature('draft'); },
    },
    {
      id: 'modify.mirror',
      title: 'Mirror',
      hint: 'Reflect the body and keep both halves',
      icon: '⇋',
      contexts: ['body'],
      enabled: needsModel,
      run: async () => { await host.addSolidFeature('mirror'); },
    },
    {
      id: 'modify.move',
      title: 'Move',
      hint: 'Offset a body',
      icon: '✥',
      contexts: ['body', 'face'],
      enabled: needsModel,
      run: async () => { await host.addMove(); },
    },

    {
      id: 'feature.hole',
      title: 'Hole',
      hint: 'Drill a sized hole from the fastener table',
      icon: '◎',
      contexts: ['face', 'always'],
      toolbar: { order: 33 },
      keys: ['h'],
      enabled: needsModel,
      run: async () => { await host.addSolidFeature('hole'); },
    },
    {
      id: 'pattern.new',
      title: 'Pattern',
      hint: 'Repeat the body in a row or around an axis',
      icon: '⁘',
      contexts: ['body', 'always'],
      toolbar: { order: 34 },
      children: ['pattern.linear', 'pattern.circular'],
      enabled: needsModel,
      run: () => {},
    },
    {
      id: 'pattern.linear',
      title: 'Linear',
      hint: 'Repeat along a direction',
      icon: '⋯',
      contexts: ['body'],
      enabled: needsModel,
      run: async () => { await host.addSolidFeature('linearPattern'); },
    },
    {
      id: 'pattern.circular',
      title: 'Circular',
      hint: 'Repeat around an axis',
      icon: '⊛',
      contexts: ['body'],
      enabled: needsModel,
      run: async () => { await host.addSolidFeature('circularPattern'); },
    },

    // ---------------------------------------------------------------- combine
    {
      id: 'boolean.combine',
      title: 'Combine',
      hint: 'Cut, fuse or intersect two bodies',
      icon: '⊕',
      contexts: ['body', 'always'],
      sector: { body: 2 },
      toolbar: { order: 40 },
      children: ['boolean.cut', 'boolean.union', 'boolean.intersect'],
      enabled: combineEnabled,
      run: () => {},
    },
    {
      id: 'boolean.cut',
      title: 'Cut',
      hint: 'Subtract the last body from the one before it',
      icon: '⊖',
      contexts: ['body', 'always'],
      enabled: combineEnabled,
      run: async () => { await host.addBoolean('cut'); },
    },
    {
      id: 'boolean.union',
      title: 'Union',
      hint: 'Fuse the last two bodies',
      icon: '⊕',
      contexts: ['body', 'always'],
      enabled: combineEnabled,
      run: async () => { await host.addBoolean('union'); },
    },
    {
      id: 'boolean.intersect',
      title: 'Intersect',
      hint: 'Keep only where the last two bodies overlap',
      icon: '⊗',
      contexts: ['body'],
      enabled: combineEnabled,
      run: async () => { await host.addBoolean('intersect'); },
    },

    // ---------------------------------------------------------------- tree
    {
      id: 'feature.delete',
      title: 'Delete',
      hint: 'Remove the selected body, or the selected sketch geometry',
      icon: '␡',
      // Every context, because Delete means the same thing everywhere: get rid of what
      // is selected. Picking a face to delete the body is what people expect; nobody
      // selects one face in order to delete a face.
      contexts: ['tree-item', 'body', 'face', 'edge', 'vertex', 'sketch'],
      keys: ['delete', 'backspace'],
      sector: { 'tree-item': 0, sketch: 5 },
      enabled: (s) => (s.sketching
        ? (s.sketchSelectionCount > 0 ? true : 'Select sketch geometry first')
        : (s.selectionCount > 0 || s.focusedFeature ? true : 'Select a body or a feature')),
      run: async () => { await host.deleteFocused(); },
    },
    {
      id: 'feature.suppress',
      title: 'Suppress',
      hint: 'Skip this feature without deleting it',
      icon: '⊘',
      contexts: ['tree-item'],
      sector: { 'tree-item': 2 },
      enabled: (s) => (s.focusedFeature ? true : 'Select a feature in the tree'),
      run: async () => { await host.suppressFocused(true); },
    },

    // ---------------------------------------------------------------- view
    {
      id: 'view.fit',
      title: 'Fit',
      hint: 'Frame the whole model',
      icon: '⤢',
      contexts: ['empty', 'always'],
      sector: { empty: 6 },
      keys: ['f'],
      enabled: needsModel,
      run: () => host.fitAll(),
    },
    {
      id: 'view.lookAt',
      title: 'Look at face',
      hint: 'Square the camera to the selected face',
      icon: '⊙',
      contexts: ['face'],
      sector: { face: 2 },
      enabled: needsSelection('face', 'a face'),
      run: () => { host.lookAtSelection(); },
    },
    {
      id: 'view.pivot',
      title: 'Pivot here',
      hint: 'Orbit around this point',
      icon: '✜',
      contexts: ['face', 'edge', 'vertex'],
      sector: { face: 6, edge: 2, vertex: 0 },
      keys: ['.'],
      enabled: (s) => (s.hoverKind || s.selectionCount ? true : 'Point at the model first'),
      run: () => { host.pivotToSelection(); },
    },

    // ---------------------------------------------------------------- document
    {
      id: 'edit.undo',
      title: 'Undo',
      icon: '↶',
      contexts: ['always'],
      keys: ['ctrl+z'],
      enabled: (s) => (s.canUndo ? true : 'Nothing to undo'),
      run: () => host.undo(),
    },
    {
      id: 'edit.redo',
      title: 'Redo',
      icon: '↷',
      contexts: ['always'],
      keys: ['ctrl+shift+z', 'ctrl+y'],
      enabled: (s) => (s.canRedo ? true : 'Nothing to redo'),
      run: () => host.redo(),
    },
    // ---------------------------------------------------------------- print
    {
      id: 'print.menu',
      title: 'Print',
      hint: 'See the part as the printer will: overhangs, thin walls, fit, orientation',
      icon: '⬒',
      contexts: ['always'],
      toolbar: { order: 80 },
      children: ['print.overhang', 'print.thickness', 'print.volume', 'print.orient', 'print.printer'],
      enabled: () => true,
      run: () => {},
    },
    {
      id: 'print.overhang',
      title: 'Overhangs',
      hint: 'Shade surface that would need support; the first layer in green',
      icon: '◢',
      contexts: ['always'],
      enabled: (s) => (s.hasModel ? true : 'Nothing to check yet'),
      active: (s) => s.analysis === 'overhang',
      run: () => host.toggleAnalysis('overhang'),
    },
    {
      id: 'print.thickness',
      title: 'Thin walls',
      hint: 'Shade walls thinner than two nozzle widths',
      icon: '▯',
      contexts: ['always'],
      enabled: (s) => (s.hasModel ? true : 'Nothing to check yet'),
      active: (s) => s.analysis === 'thickness',
      run: () => host.toggleAnalysis('thickness'),
    },
    {
      id: 'print.volume',
      title: 'Build volume',
      hint: "Draw the printer's bed; red when the part does not fit",
      icon: '⬚',
      contexts: ['always'],
      enabled: () => true,
      active: (s) => s.buildVolume,
      run: () => host.toggleBuildVolume(),
    },
    {
      id: 'print.orient',
      title: 'Orientation',
      hint: 'Which way up to print it, scored for overhang and support',
      icon: '⟲',
      contexts: ['always'],
      enabled: (s) => (s.hasModel ? true : 'Nothing to orient yet'),
      run: () => host.openOrientations(),
    },
    {
      id: 'print.printer',
      title: 'Printer…',
      hint: 'Bed size, nozzle, layer height, overhang limit',
      icon: '⚙',
      contexts: ['always'],
      enabled: () => true,
      run: () => host.openPrinterSettings(),
    },
    {
      id: 'file.menu',
      title: 'File',
      hint: 'New, open and save',
      icon: '▤',
      contexts: ['always'],
      toolbar: { order: 89, pin: 'end' },
      children: ['file.new', 'file.open', 'file.save', 'file.saveAs', 'file.import'],
      enabled: () => true,
      run: () => {},
    },
    {
      id: 'file.new',
      title: 'New',
      hint: 'Start a fresh part',
      icon: '✦',
      contexts: ['always'],
      enabled: (s) => (s.sketching ? 'Finish the sketch first' : true),
      run: () => host.newDocument(),
    },
    {
      id: 'file.open',
      title: 'Open…',
      hint: 'Open a .card file',
      icon: '▥',
      contexts: ['always'],
      keys: ['ctrl+o'],
      enabled: (s) => (s.sketching ? 'Finish the sketch first' : true),
      run: () => host.openDocument(),
    },
    {
      id: 'file.save',
      title: 'Save',
      hint: 'Save the part; asks where the first time',
      icon: '▣',
      contexts: ['always'],
      keys: ['ctrl+s'],
      enabled: () => true,
      run: () => host.saveDocument(),
    },
    {
      id: 'file.saveAs',
      title: 'Save as…',
      hint: 'Save the part under a new name',
      icon: '▧',
      contexts: ['always'],
      keys: ['ctrl+shift+s'],
      enabled: () => true,
      run: () => host.saveDocumentAs(),
    },
    {
      id: 'file.import',
      title: 'Import…',
      hint: 'Bring in a STEP or STL to model against',
      icon: '⭱',
      contexts: ['always'],
      enabled: (s) => (s.sketching ? 'Finish the sketch first' : true),
      run: () => host.importModel(),
    },
    {
      id: 'file.export',
      title: 'Export…',
      hint: 'Save as STL, 3MF, OBJ or STEP',
      icon: '⭳',
      contexts: ['always'],
      toolbar: { order: 90, pin: 'end' },
      keys: ['ctrl+e'],
      enabled: (s) => (s.hasModel ? true : 'Nothing to export yet'),
      run: () => host.openExport(),
    },
    {
      id: 'select.cycleFilter',
      title: 'Selection filter',
      hint: 'Cycle face / edge / vertex / body',
      icon: '⧉',
      contexts: ['always'],
      keys: ['tab'],
      enabled: () => true,
      run: () => host.cycleSelectionFilter(1),
    },
    {
      id: 'select.clear',
      title: 'Clear selection',
      hint: 'Drop the selection; in a sketch, put the drawing tool down first',
      icon: '⨯',
      contexts: ['always', 'edge'],
      sector: { edge: 6 },
      keys: ['escape'],
      enabled: (s) => (s.sketching || s.selectionCount > 0
        ? true
        : 'Nothing selected'),
      run: () => {
        // In a sketch, Escape means "stop drawing" before it means anything else. A
        // drawing tool that keeps drawing after Escape is the thing that makes editing an
        // existing sketch — delete a line, draw a new one, stop — feel like a fight.
        if (host.state().sketching && host.state().sketchTool !== 'select') {
          host.setSketchTool('select');
          return;
        }
        host.clearSelection();
      },
    },
    {
      id: 'app.about',
      title: 'CARDstock',
      hint: 'What the name means, and which build this is',
      icon: '◈',
      contexts: ['always'],
      toolbar: { order: 91, pin: 'end', compact: true },
      enabled: () => true,
      run: () => host.openAbout(),
    },
    {
      id: 'app.keys',
      title: 'Keys',
      hint: 'Every key the app answers to',
      icon: '⌨',
      contexts: ['always'],
      // '?' arrives as shift+? — the chord carries the modifier that produced it.
      keys: ['shift+?', 'f1'],
      enabled: () => true,
      run: () => host.openKeys(),
    },
    {
      id: 'app.palette',
      title: 'Command palette',
      hint: 'Search every command',
      icon: '⌘',
      contexts: ['always'],
      keys: ['ctrl+k'],
      enabled: () => true,
      run: () => host.openPalette(),
    },
  ];
}
