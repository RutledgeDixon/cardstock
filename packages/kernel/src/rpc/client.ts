import {
  type BooleanOp, type Bounds, type BoxSpec, type CylinderSpec, type GeometryResult,
  type KernelPort, type MassProperties, type Matrix4, type ShapeHandle, type SphereSpec,
  type TessellatedBody, type TessellationQuality, type TopologyCounts, type BodyId,
  type ShapeDescription,
  KernelError,
} from '@cardstock/types';
import { isKernelReady, type KernelMethod, type KernelResponse } from './protocol.js';

/**
 * Main-thread KernelPort that forwards to the geometry worker.
 *
 * Implements the same interface as OcctKernel and MockKernel, so the document cannot
 * tell which it is talking to — which is exactly what made Phase 2 testable and what
 * lets Phase 3 be a swap rather than a rewrite.
 */
export class WorkerKernel implements KernelPort {
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  #nextId = 0;
  #ready: Promise<number>;

  constructor(private readonly worker: Worker) {
    let resolveReady: (bootMs: number) => void;
    this.#ready = new Promise<number>((resolve) => { resolveReady = resolve; });

    worker.addEventListener('message', (event: MessageEvent<KernelResponse | unknown>) => {
      if (isKernelReady(event.data)) {
        resolveReady(event.data.bootMs);
        return;
      }
      const response = event.data as KernelResponse;
      if (!response || typeof response.id !== 'number') return;
      const pending = this.#pending.get(response.id);
      if (!pending) return;
      this.#pending.delete(response.id);
      if (response.ok) pending.resolve(response.value);
      else pending.reject(new KernelError(response.error.message, response.error.operation ?? 'kernel'));
    });

    worker.addEventListener('error', (event) => {
      const error = new Error(`geometry worker failed: ${event.message}`);
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
    });
  }

  /** Resolves with the worker's WASM boot time once geometry is available. */
  whenReady(): Promise<number> { return this.#ready; }

  #call<T>(method: KernelMethod, ...args: unknown[]): Promise<T> {
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ id, method, args });
    });
  }

  makeBox(spec: BoxSpec) { return this.#call<GeometryResult>('makeBox', spec); }
  makeCylinder(spec: CylinderSpec) { return this.#call<GeometryResult>('makeCylinder', spec); }
  makeSphere(spec: SphereSpec) { return this.#call<GeometryResult>('makeSphere', spec); }

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
  release(shape: ShapeHandle) { return this.#call<void>('release', shape); }

  terminate(): void {
    this.worker.terminate();
    for (const pending of this.#pending.values()) {
      pending.reject(new Error('geometry worker terminated'));
    }
    this.#pending.clear();
  }
}

/** Spawn the geometry worker and wrap it. */
export function createWorkerKernel(): WorkerKernel {
  const worker = new Worker(new URL('../worker/kernel.worker.ts', import.meta.url), {
    type: 'module',
    name: 'cardstock-geometry',
  });
  return new WorkerKernel(worker);
}
