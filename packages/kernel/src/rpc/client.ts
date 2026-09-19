import {
  type BooleanOp, type Bounds, type BoxSpec, type CylinderSpec, type GeometryResult,
  type KernelPort, type MassProperties, type Matrix4, type ShapeHandle, type SphereSpec,
  type TessellatedBody, type TessellationQuality, type TopologyCounts, type BodyId,
  type ShapeDescription,
  type ProfileSpec, type Vec3,
  type ExportFormat, type ExportOptions, type ExportResult, type MeshStats,
  type OrientationOptions, type OrientationSuggestion, type FaceOutline,
  KernelError, KernelTimeoutError,
} from '@cardstock/types';
import { isKernelReady, type KernelMethod, type KernelResponse } from './protocol.js';

/**
 * Main-thread KernelPort that forwards to the geometry worker.
 *
 * Implements the same interface as OcctKernel and MockKernel, so the document cannot
 * tell which it is talking to — which is exactly what made Phase 2 testable and what
 * lets Phase 3 be a swap rather than a rewrite.
 */
/** How long a single kernel call may run before the worker is stopped and restarted. */
export const DEFAULT_CALL_TIMEOUT_MS = 30_000;

/** Calls that legitimately take a while on a big input get a longer leash. */
const LONG_CALLS: ReadonlySet<KernelMethod> = new Set<KernelMethod>([
  'importStl', 'importStep', 'exportModel', 'exportStl', 'meshStats', 'scoreOrientations',
]);

export interface WorkerKernelOptions {
  /** Per-call limit; long imports and exports get four times this. */
  readonly timeoutMs?: number;
  /**
   * Called after the worker has been replaced — every shape handle the caller holds is
   * now dead, and whatever owns the geometry cache must rebuild from nothing.
   */
  readonly onRestart?: (reason: KernelError) => void;
  /** Called when a call finished but took longer than `slowMs` (default 5 s). */
  readonly onSlow?: (method: KernelMethod, ms: number) => void;
  readonly slowMs?: number;
}

interface Pending {
  readonly method: KernelMethod;
  readonly resolve: (v: unknown) => void;
  readonly reject: (e: Error) => void;
  readonly started: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export class WorkerKernel implements KernelPort {
  #pending = new Map<number, Pending>();
  #nextId = 0;
  #ready!: Promise<number>;
  #worker!: Worker;
  #detach: (() => void) | null = null;
  readonly #timeoutMs: number;
  readonly #onRestart: ((reason: KernelError) => void) | undefined;
  readonly #onSlow: ((method: KernelMethod, ms: number) => void) | undefined;
  readonly #slowMs: number;
  /** Restarts so far; the boot promise of a dead worker is never awaited. */
  #epoch = 0;

  constructor(
    private readonly spawn: () => Worker,
    options: WorkerKernelOptions = {},
  ) {
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.#onRestart = options.onRestart;
    this.#onSlow = options.onSlow;
    this.#slowMs = options.slowMs ?? 5000;
    this.#attach(spawn());
  }

  #attach(worker: Worker): void {
    this.#worker = worker;
    let resolveReady: (bootMs: number) => void;
    this.#ready = new Promise<number>((resolve) => { resolveReady = resolve; });

    const onMessage = (event: MessageEvent<KernelResponse | unknown>) => {
      if (isKernelReady(event.data)) {
        resolveReady(event.data.bootMs);
        return;
      }
      const response = event.data as KernelResponse;
      if (!response || typeof response.id !== 'number') return;
      const pending = this.#pending.get(response.id);
      if (!pending) return;
      this.#pending.delete(response.id);
      if (pending.timer) clearTimeout(pending.timer);
      const took = performance.now() - pending.started;
      if (took > this.#slowMs) this.#onSlow?.(pending.method, took);
      if (response.ok) pending.resolve(response.value);
      else pending.reject(new KernelError(response.error.message, response.error.operation ?? 'kernel'));
    };
    const onError = (event: ErrorEvent) => {
      this.#failAll(new Error(`geometry worker failed: ${event.message}`));
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    this.#detach = () => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
    };
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  /** Resolves with the worker's WASM boot time once geometry is available. */
  whenReady(): Promise<number> { return this.#ready; }

  /** How many times the worker has been replaced. */
  get restarts(): number { return this.#epoch; }

  /**
   * Stop whatever the worker is doing, right now.
   *
   * OCCT cannot be interrupted from outside, so the only way to get out of a fillet that
   * is never going to finish is to kill the thread it runs on. Every call in flight
   * rejects; the one named in `culprit` (or the oldest, when a timer fired) rejects with
   * a KernelTimeoutError so its feature is remembered as one not to retry. A fresh
   * worker is booted, and `onRestart` tells the owner that all its handles are gone.
   */
  abort(reason = 'stopped'): void {
    const oldest = this.#pending.values().next().value as Pending | undefined;
    this.#restart(oldest?.method ?? 'kernel', reason);
  }

  #restart(method: string, why: string): void {
    this.#epoch++;
    this.#detach?.();
    this.#worker.terminate();

    const culprit = new KernelTimeoutError(
      `${method} ${why} — the geometry engine was restarted`, method,
    );
    const rest = new KernelError('the geometry engine was restarted', method);
    let first = true;
    for (const pending of this.#pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(first ? culprit : rest);
      first = false;
    }
    this.#pending.clear();

    this.#attach(this.spawn());
    this.#onRestart?.(culprit);
  }

  #call<T>(method: KernelMethod, ...args: unknown[]): Promise<T> {
    const id = this.#nextId++;
    const epoch = this.#epoch;
    return new Promise<T>((resolve, reject) => {
      const pending: Pending = {
        method, resolve: resolve as (v: unknown) => void, reject, timer: null, started: performance.now(),
      };
      this.#pending.set(id, pending);
      this.#worker.postMessage({ id, method, args });

      // The clock starts once the worker is up, so a slow first load of the WASM module
      // is never mistaken for a hung operation.
      const limit = this.#timeoutMs * (LONG_CALLS.has(method) ? 4 : 1);
      void this.#ready.then(() => {
        if (this.#epoch !== epoch || !this.#pending.has(id)) return;
        pending.timer = setTimeout(() => {
          if (!this.#pending.has(id)) return;
          console.warn(`[kernel] ${method} exceeded ${limit / 1000}s; restarting the geometry worker`, args);
          // Reorder so the call that overran is the one blamed.
          this.#pending.delete(id);
          this.#pending = new Map([[id, pending], ...this.#pending]);
          this.#restart(method, `took longer than ${Math.round(limit / 1000)} s`);
        }, limit);
      });
    });
  }

  makeBox(spec: BoxSpec) { return this.#call<GeometryResult>('makeBox', spec); }
  makeCylinder(spec: CylinderSpec) { return this.#call<GeometryResult>('makeCylinder', spec); }
  makeSphere(spec: SphereSpec) { return this.#call<GeometryResult>('makeSphere', spec); }

  makeFace(profile: ProfileSpec) { return this.#call<GeometryResult>('makeFace', profile); }
  extrude(shape: ShapeHandle, distance: number, symmetric?: boolean) {
    return this.#call<GeometryResult>('extrude', shape, distance, symmetric);
  }

  revolve(shape: ShapeHandle, axis: { origin: Vec3; direction: Vec3 }, angle: number) {
    return this.#call<GeometryResult>('revolve', shape, axis, angle);
  }
  makePath(profile: ProfileSpec) {
    return this.#call<GeometryResult>('makePath', profile);
  }
  sweep(profile: ShapeHandle, path: ShapeHandle) {
    return this.#call<GeometryResult>('sweep', profile, path);
  }
  loft(profiles: readonly ShapeHandle[], options?: { ruled?: boolean }) {
    return this.#call<GeometryResult>('loft', profiles, options);
  }
  draft(
    shape: ShapeHandle,
    faces: readonly number[],
    angle: number,
    pull: Vec3,
    neutralPlane: { origin: Vec3; normal: Vec3 },
  ) {
    return this.#call<GeometryResult>('draft', shape, faces, angle, pull, neutralPlane);
  }
  booleanMany(op: BooleanOp, base: ShapeHandle, tools: readonly ShapeHandle[]) {
    return this.#call<GeometryResult>('booleanMany', op, base, tools);
  }
  transformMany(shape: ShapeHandle, matrices: readonly Matrix4[]) {
    return this.#call<GeometryResult[]>('transformMany', shape, matrices);
  }
  stats() { return this.#call<{ shapes: number }>('stats'); }
  beginScope() { return this.#call<void>('beginScope'); }
  endScope(keep: readonly ShapeHandle[]) { return this.#call<number>('endScope', keep); }
  compound(shapes: readonly ShapeHandle[]) {
    return this.#call<GeometryResult>('compound', shapes);
  }
  shell(shape: ShapeHandle, openFaces: readonly number[], thickness: number) {
    return this.#call<GeometryResult>('shell', shape, openFaces, thickness);
  }
  mirror(shape: ShapeHandle, plane: { origin: Vec3; normal: Vec3 }) {
    return this.#call<GeometryResult>('mirror', shape, plane);
  }

  boolean(op: BooleanOp, base: ShapeHandle, tool: ShapeHandle) {
    return this.#call<GeometryResult>('boolean', op, base, tool);
  }
  fillet(shape: ShapeHandle, edges: readonly number[], radius: number) {
    return this.#call<GeometryResult>('fillet', shape, edges, radius);
  }
  chamfer(shape: ShapeHandle, edges: readonly number[], distance: number) {
    return this.#call<GeometryResult>('chamfer', shape, edges, distance);
  }
  transform(shape: ShapeHandle, matrix: Matrix4) {
    return this.#call<GeometryResult>('transform', shape, matrix);
  }

  tessellate(shape: ShapeHandle, bodyId: BodyId, quality: TessellationQuality) {
    return this.#call<TessellatedBody>('tessellate', shape, bodyId, quality);
  }
  massProperties(shape: ShapeHandle) {
    return this.#call<MassProperties>('massProperties', shape);
  }
  describeShape(shape: ShapeHandle) {
    return this.#call<ShapeDescription>('describeShape', shape);
  }
  boundingBox(shape: ShapeHandle) { return this.#call<Bounds>('boundingBox', shape); }
  topologyCounts(shape: ShapeHandle) {
    return this.#call<TopologyCounts>('topologyCounts', shape);
  }
  exportStl(shape: ShapeHandle, options?: { quality?: TessellationQuality; binary?: boolean }) {
    return this.#call<Uint8Array>('exportStl', shape, options);
  }
  exportModel(shape: ShapeHandle, format: ExportFormat, options?: ExportOptions) {
    return this.#call<ExportResult>('exportModel', shape, format, options);
  }
  meshStats(shape: ShapeHandle, quality: TessellationQuality) {
    return this.#call<MeshStats>('meshStats', shape, quality);
  }
  scoreOrientations(shape: ShapeHandle, options: OrientationOptions) {
    return this.#call<OrientationSuggestion[]>('scoreOrientations', shape, options);
  }
  faceOutline(shape: ShapeHandle, faceIndex: number) {
    return this.#call<FaceOutline>('faceOutline', shape, faceIndex);
  }
  importStep(text: string) { return this.#call<GeometryResult>('importStep', text); }
  importStl(bytes: Uint8Array) { return this.#call<GeometryResult>('importStl', bytes); }
  release(shape: ShapeHandle) { return this.#call<void>('release', shape); }

  terminate(): void {
    this.#detach?.();
    this.#worker.terminate();
    this.#failAll(new Error('geometry worker terminated'));
  }
}

/** Spawn the geometry worker and wrap it. */
export function createWorkerKernel(options: WorkerKernelOptions = {}): WorkerKernel {
  return new WorkerKernel(() => new Worker(
    new URL('../worker/kernel.worker.ts', import.meta.url),
    { type: 'module', name: 'cardstock-geometry' },
  ), options);
}
