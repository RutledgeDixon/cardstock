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
  /** Handles allocated inside each open scope, innermost last. */
  #scopes: ShapeHandle[][] = [];

  get size(): number { return this.#shapes.size; }

  add(shape: TopoDS_Shape): ShapeHandle {
    const handle = `s${this.#next++}` as ShapeHandle;
    this.#shapes.set(handle, { shape, refs: 1 });
    this.#scopes[this.#scopes.length - 1]?.push(handle);
    return handle;
  }

  /**
   * Start recording allocations.
   *
   * A feature that drills a hole allocates a cylinder on the way to its answer, and a
   * pattern allocates a copy per instance. Only the final shape is returned, so the rest
   * had no owner and stayed in the WASM heap forever: a 20-copy pattern leaked twenty
   * shapes per rebuild, growing linearly for as long as the user scrubbed a dimension.
   *
   * Recorded here rather than remembered by each feature, because "remember to free your
   * intermediates" is a rule every new feature would have to re-learn.
   */
  beginScope(): void { this.#scopes.push([]); }

  /**
   * Release everything allocated in the innermost scope except what is kept.
   *
   * Anything the feature received as an INPUT was allocated in an earlier scope, so it
   * is never a candidate — a feature that passes its input straight through is safe.
   *
   * @returns how many shapes were actually freed.
   */
  endScope(keep: Iterable<ShapeHandle>): number {
    const allocated = this.#scopes.pop();
    if (!allocated) return 0;
    const kept = new Set(keep);

    let freed = 0;
    for (const handle of allocated) {
      if (kept.has(handle)) {
        // Hand it up: an enclosing scope now owns it, or nothing does at the top level.
        this.#scopes[this.#scopes.length - 1]?.push(handle);
        continue;
      }
      if (this.release(handle)) freed++;
    }
    return freed;
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
    this.#scopes = [];
  }
}
