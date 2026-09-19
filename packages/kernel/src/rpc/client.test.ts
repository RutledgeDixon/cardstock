import { describe, expect, it, vi } from 'vitest';
import { KernelTimeoutError } from '@cardstock/types';
import { WorkerKernel } from './client.js';

/**
 * A stand-in worker: answers `stats` at once, never answers `fillet`, and boots
 * instantly. Enough to prove the watchdog kills a hung call and comes back.
 */
class FakeWorker extends EventTarget {
  static spawned = 0;
  terminated = false;
  constructor() {
    super();
    FakeWorker.spawned++;
    queueMicrotask(() => this.dispatchEvent(Object.assign(new Event('message'), { data: { type: 'ready', bootMs: 1 } })));
  }
  postMessage(request: { id: number; method: string }) {
    if (request.method === 'fillet') return; // hangs forever
    queueMicrotask(() => this.dispatchEvent(Object.assign(new Event('message'), {
      data: { id: request.id, ok: true, value: { shapes: 0 } },
    })));
  }
  terminate() { this.terminated = true; }
}

describe('the geometry watchdog', () => {
  it('stops a call that overruns, restarts the worker, and blames the right call', async () => {
    vi.useFakeTimers();
    const workers: FakeWorker[] = [];
    const restarted = vi.fn();
    const kernel = new WorkerKernel(() => {
      const w = new FakeWorker();
      workers.push(w);
      return w as unknown as Worker;
    }, { timeoutMs: 1000, onRestart: restarted });
    await kernel.whenReady();

    const hung = kernel.fillet('s1' as never, [0], 1);
    const bystander = kernel.stats();
    const caught = hung.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1500);

    const error = await caught;
    expect(error).toBeInstanceOf(KernelTimeoutError);
    expect((error as Error).message).toMatch(/fillet took longer than 1 s/);
    expect(workers[0]!.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    expect(restarted).toHaveBeenCalledOnce();
    expect(kernel.restarts).toBe(1);
    // The fast call had already answered before the timer fired.
    await expect(bystander).resolves.toEqual({ shapes: 0 });

    // The replacement works.
    await expect(kernel.stats()).resolves.toEqual({ shapes: 0 });
    vi.useRealTimers();
  });

  it('can be stopped by hand', async () => {
    const kernel = new WorkerKernel(() => new FakeWorker() as unknown as Worker, { timeoutMs: 60_000 });
    await kernel.whenReady();
    const hung = kernel.fillet('s1' as never, [0], 1).catch((e: unknown) => e);
    kernel.abort('was stopped');
    const error = await hung;
    expect(error).toBeInstanceOf(KernelTimeoutError);
    expect((error as Error).message).toMatch(/fillet was stopped/);
  });
});
