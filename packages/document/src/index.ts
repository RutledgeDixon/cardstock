export {
  Document,
  type DocumentSnapshot, type EditOptions, type ReorderResult, type RewireEdit,
} from './document.js';

export {
  ParameterTable, validateParameterName,
  type Parameter, type ParameterValue, type Unit,
} from './params/parameters.js';
export {
  ExpressionError, evaluate, evaluateExpression, parse, referencedNames, tokenize,
  type Ast, type Scope,
} from './params/expression.js';

export {
  FeatureRegistry,
  type ComputeContext, type Feature, type FeatureDefinition,
} from './features/feature.js';
export { BUILTIN_FEATURES, createBuiltinRegistry } from './features/builtins.js';

export {
  CancellationToken, RecomputeEngine,
  type FeatureState, type FeatureStatusKind, type RecomputeOptions, type RecomputeResult,
} from './graph/recompute.js';
export {
  DependencyGraph, featureNode, isFeatureNode, isParamNode, nodeName, paramNode,
  type NodeId, type TopologicalResult,
} from './graph/dependency-graph.js';
export { buildGraph } from './graph/build-graph.js';
export { canonicalize, contentHash, hashString } from './graph/hash.js';

export { History, type HistoryOptions } from './undo/history.js';
export {
  CURRENT_SCHEMA_VERSION, DocumentFormatError, MIGRATIONS, migrate, validate,
  type DocumentFile, type DocumentMeta, type Migration,
} from './serialize/schema.js';

export {
  MockKernel, mockFingerprint, mockTopoRef, type MockCall,
} from './mock-kernel/mock-kernel.js';

export {
  DEFAULT_THRESHOLDS, bestMatch, captureTopoRef, resolveTopoRef, scoreMatch,
  type HistoryStep, type MatchThresholds, type Resolution, type ResolutionMethod,
  type TopoRef,
} from './toporef/index.js';

export {
  Sketch, distance, referencedIds,
  type SketchData, type SketchPlane, type SketchStatus,
} from './sketch/sketch.js';
export {
  DEFAULT_INFERENCE, inferAxisAlignment, inferForNewLine, snapToAxis, snapToPoint,
  type Inference, type InferenceOptions,
} from './sketch/inference.js';
export { MockSolver } from './sketch/mock-solver.js';
export {
  buildProfile, outerLoop, signedArea,
  type ProfileLoop, type ProfileResult,
} from './sketch/profile.js';
export {
  ORIGIN_PLANES, resolvePlacement, toSketch, toWorld,
} from './sketch/placement.js';
export { extrudeFeature, sketchFeature } from './features/sketch-features.js';
