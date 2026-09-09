import initOpenCascade, { type OpenCascadeInstance } from 'replicad-opencascadejs';
import { OcctKernel } from './kernel.js';

/**
 * Load OCCT and hand back a kernel.
 *
 * The instance is a singleton per thread: the WASM module is ~22 MB (4.8 MB brotli) and
 * takes ~175 ms to boot, so it is loaded once and shared. See ADR-0001 for why this is
 * replicad's trimmed build rather than the full 62.8 MB one.
 */
let instance: Promise<OpenCascadeInstance> | null = null;

export interface SessionOptions {
  /** Override how the .wasm is located — needed when bundling for the browser. */
  locateFile?: (path: string) => string;
}

export function loadOpenCascade(options: SessionOptions = {}): Promise<OpenCascadeInstance> {
  instance ??= initOpenCascade(
    options.locateFile ? { locateFile: options.locateFile } : {},
  );
  return instance;
}

export async function createOcctKernel(options: SessionOptions = {}): Promise<OcctKernel> {
  return new OcctKernel(await loadOpenCascade(options));
}

/** Testing hook: forget the cached instance. */
export function resetOpenCascadeForTests(): void { instance = null; }
