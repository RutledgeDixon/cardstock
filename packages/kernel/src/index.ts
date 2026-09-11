export { OcctKernel } from './occt/kernel.js';
export { ShapeRegistry } from './occt/registry.js';
export {
  createOcctKernel, loadOpenCascade, resetOpenCascadeForTests, type SessionOptions,
} from './occt/session.js';
export {
  subShapes, countSubShapes, drainShapeList, indexOfShape, shapeIndexer, asWire,
  type ShapeKind,
} from './occt/topology.js';
export { captureHistory, type HistoryBuilder } from './occt/history.js';
export { tessellate, tessellationTransferables } from './tessellate/tessellate.js';
export { WorkerKernel, createWorkerKernel } from './rpc/client.js';
export { PlaneGcsSolver, loadSolver } from './solver/planegcs.js';
export {
  isKernelReady, type KernelMethod, type KernelReady, type KernelRequest, type KernelResponse,
} from './rpc/protocol.js';
export {
  weld, triangleCount, signedVolume, isWatertight, encodeStlBinary, encodeStlAscii, encodeObj,
  encode3mf, zipStore, zipEntryNames, scoreOrientations, rotationTaking, type ExportMesh,
} from './export/index.js';
