export { Viewer, type ViewerOptions } from './scene/viewer.js';
export { BodyView } from './scene/body-view.js';
export {
  DEFAULT_SKETCH_COLOURS, SketchView, type SketchViewColours,
} from './scene/sketch-view.js';
export { Grid, chooseGridSpacing, type GridOptions } from './scene/grid.js';

export {
  CameraController,
  DEFAULT_TUNING,
  shortestAngleDelta,
  type CameraTuning,
} from './camera/controller.js';
export {
  ELEVATION_LIMIT,
  ISO_ELEVATION,
  NAMED_VIEWS,
  applyToCamera,
  clampElevation,
  fitBounds,
  makeTurntableState,
  normalizeAzimuth,
  orbitDirection,
  viewFacing,
  type NamedView,
  type TurntableState,
} from './camera/turntable.js';

export { Picker, type PickResult } from './picking/picker.js';
export {
  SelectionManager,
  type SelectionListener,
  type SelectionSnapshot,
} from './picking/selection.js';

export { SolidMaterial, type SolidMaterialOptions, type AnalysisMode } from './materials/solid.js';
export { computeVertexThickness } from './analysis/thickness.js';
export { BuildVolume } from './analysis/build-volume.js';
export { WireMaterial } from './materials/wire.js';

export { KeyboardCameraInput, VIEW_KEYS, type KeyboardOptions } from './input/keyboard.js';
