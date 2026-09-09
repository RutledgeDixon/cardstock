import type { TopoDS_Shape } from 'replicad-opencascadejs';
import type { ShapeHandle } from '@cardstock/types';

/**
 * Handle registry for shapes living inside OCCT.
 *
 * Every OCCT object is manually managed — emscripten cannot garbage-collect them — so
 * anything allocated and forgotten is a genuine leak inside the WASM heap. The document
 * releases handles as it evicts them from the content cache; this is what turns that
 * into an actual `delete()`.
 *
 * Refcounted because the same shape legitimately reaches several handles: a suppressed
 * or failed feature passes its input straight through.
 */
export class ShapeRegistry {
  #shapes = new Map<string, { shape: TopoDS_Shape; refs: number }>();
  #next = 0;

  get size(): number { return this.#shapes.size; }

  add(shape: TopoDS_Shape): ShapeHandle {
    const handle = `s${this.#next++}` as ShapeHandle;
    this.#shapes.set(handle, { shape, refs: 1 });
    return handle;
  }

  get(handle: ShapeHandle): TopoDS_Shape {
    const entry = this.#shapes.get(handle);
    if (!entry) throw new Error(`unknown shape handle "${handle}"`);
    return entry.shape;
  }

  has(handle: ShapeHandle): boolean { return this.#shapes.has(handle); }

  retain(handle: ShapeHandle): void {
    const entry = this.#shapes.get(handle);
    if (entry) entry.refs++;
  }

  /** @returns true when the shape was actually freed. */
  release(handle: ShapeHandle): boolean {
    const entry = this.#shapes.get(handle);
    if (!entry) return false;
    entry.refs--;
    if (entry.refs > 0) return false;
    this.#shapes.delete(handle);
    entry.shape.delete();
    return true;
  }

  /** Free everything. Called when a document closes. */
  clear(): void {
    for (const entry of this.#shapes.values()) entry.shape.delete();
    this.#shapes.clear();
  }
}
