/// <reference lib="webworker" />
import type { TessellatedBody } from '@cardstock/types';
import { createOcctKernel } from '../occt/session.js';
import type { OcctKernel } from '../occt/kernel.js';
import { tessellationTransferables } from '../tessellate/tessellate.js';
import type { KernelRequest, KernelResponse } from '../rpc/protocol.js';

/**
 * The geometry worker.
 *
 * Everything OCCT happens here. Boot takes ~175 ms and a boolean ~60 ms (ADR-0001), so
 * keeping it off the main thread is what lets the viewport stay at 60fps while a model
 * rebuilds.
 */

let kernel: OcctKernel | null = null;
const ready = (async () => {
  const started = performance.now();
  kernel = await createOcctKernel();
  self.postMessage({ type: 'ready', bootMs: Math.round(performance.now() - started) });
})();

function isTessellation(value: unknown): value is TessellatedBody {
  return typeof value === 'object' && value !== null && 'triangleFaceId' in value;
}

self.onmessage = async (event: MessageEvent<KernelRequest>) => {
  const request = event.data;
  if (!request || typeof request.id !== 'number') return;

  try {
    await ready;
    const target = kernel as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const method = target[request.method];
    if (typeof method !== 'function') {
      throw new Error(`unknown kernel method "${request.method}"`);
    }

    const value = await method.apply(kernel, [...request.args]);
    const response: KernelResponse = { id: request.id, ok: true, value };

    // Hand mesh buffers over rather than copying them; a fine tessellation is megabytes.
    if (isTessellation(value)) {
      self.postMessage(response, { transfer: tessellationTransferables(value) });
    } else {
      self.postMessage(response);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const operation = (error as { operation?: string })?.operation;
    self.postMessage({
      id: request.id,
      ok: false,
      error: operation ? { message, operation } : { message },
    } satisfies KernelResponse);
  }
};
