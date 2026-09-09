export { Document, type DocumentSnapshot, type EditOptions } from './document.js';

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

export { MockKernel, type MockCall } from './mock-kernel/mock-kernel.js';
