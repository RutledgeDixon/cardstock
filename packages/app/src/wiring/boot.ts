import type { SolveRequest, SolveResult, SolverPort } from '@cardstock/types';
import type { Document } from '@cardstock/document';
import { PlaneGcsSolver } from '@cardstock/kernel';
import { KeyboardCameraInput, type Viewer } from '@cardstock/viewer';

/**
 * Loads PlaneGCS on first use.
 *
 * The Document needs a SolverPort at construction, but the WASM module is async. Waiting
 * for it before showing anything would delay the whole app for a solver most sessions
 * never touch.
 */
export class LazySolver implements SolverPort {
  #solver: Promise<SolverPort> | null = null;

  solve(request: SolveRequest): Promise<SolveResult> {
    this.#solver ??= PlaneGcsSolver.create();
    return this.#solver.then((solver) => solver.solve(request));
  }
}

/**
 * Start the things that cleanup tears down: the render loop, camera keys, resize.
 *
 * One function, used by both the first effect run and every StrictMode re-run, so a
 * binding cannot be present on one path and missing on the other.
 */
export function activate(viewer: Viewer, canvas: HTMLCanvasElement): () => void {
  viewer.resize();
  viewer.start();

  const keyboard = new KeyboardCameraInput(viewer);
  keyboard.attach();

  const observer = new ResizeObserver(() => viewer.resize());
  observer.observe(canvas);

  return () => {
    observer.disconnect();
    keyboard.detach();
    viewer.stop();
  };
}

/**
 * The starter part: a plate to build from.
 *
 * What a fresh boot and New both give you. An empty viewport teaches nothing, and a plate
 * is the first thing most printed parts begin as anyway.
 */
export function loadStarter(doc: Document): void {
  doc.load({
    schemaVersion: 2,
    meta: {
      name: 'Untitled', units: 'mm', application: 'CARDstock',
      created: new Date().toISOString(), modified: new Date().toISOString(),
    },
    parameters: [{ name: 'width', expression: '60', unit: 'mm' }],
    features: [{
      id: 'plate', type: 'box', name: 'Plate',
      values: { dx: 'width', dy: '40', dz: '18' }, inputs: {},
    }],
    sketches: {},
  });
}
