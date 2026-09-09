import type { KernelPort } from '@cardstock/types';

/**
 * Worker protocol.
 *
 * Deliberately thin: one request per KernelPort call, matched by id. The main thread
 * never touches OCCT — it holds opaque handles and posts messages — so a slow boolean
 * cannot jank the viewport.
 */

export type KernelMethod = keyof KernelPort;

export interface KernelRequest {
  readonly id: number;
  readonly method: KernelMethod;
  readonly args: readonly unknown[];
}

export type KernelResponse =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | {
      readonly id: number;
      readonly ok: false;
      readonly error: { readonly message: string; readonly operation?: string };
    };

/** Sent once the worker's WASM module has booted. */
export interface KernelReady {
  readonly type: 'ready';
  readonly bootMs: number;
}

export const isKernelReady = (data: unknown): data is KernelReady =>
  typeof data === 'object' && data !== null && (data as { type?: string }).type === 'ready';
