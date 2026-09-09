/**
 * Undo/redo over document snapshots.
 *
 * Snapshots rather than inverse commands: a `.card` document holds no geometry, so a
 * snapshot is a small plain object, and geometry is recovered for free by the recompute
 * engine's content-addressed cache — undoing to a previous state re-hashes to entries
 * that are still warm, so it is effectively instant without any special handling.
 *
 * Rapid edits to the same target coalesce, so dragging a parameter slider leaves one
 * undo step rather than two hundred.
 */
export interface HistoryOptions {
  /** Maximum retained states. Older ones fall off the bottom. */
  limit?: number;
  /** Edits to the same coalesceKey within this window merge into one step, ms. */
  coalesceMs?: number;
  now?: () => number;
}

interface Entry<T> {
  readonly state: T;
  readonly label: string;
  readonly coalesceKey: string | null;
  readonly at: number;
}

export class History<T> {
  #past: Entry<T>[] = [];
  #future: Entry<T>[] = [];
  #limit: number;
  #coalesceMs: number;
  #now: () => number;

  constructor(opts: HistoryOptions = {}) {
    this.#limit = opts.limit ?? 200;
    this.#coalesceMs = opts.coalesceMs ?? 400;
    this.#now = opts.now ?? (() => Date.now());
  }

  get canUndo(): boolean { return this.#past.length > 0; }
  get canRedo(): boolean { return this.#future.length > 0; }
  get depth(): number { return this.#past.length; }
  get undoLabel(): string | null { return this.#past.at(-1)?.label ?? null; }
  get redoLabel(): string | null { return this.#future.at(-1)?.label ?? null; }

  /**
   * Record the state as it was BEFORE a change.
   *
   * @param coalesceKey edits sharing a key within the coalesce window merge, so a
   *        continuous drag is one undo step. Pass null to always create a new step.
   */
  record(state: T, label: string, coalesceKey: string | null = null): void {
    const now = this.#now();
    const last = this.#past.at(-1);
    if (
      coalesceKey !== null &&
      last &&
      last.coalesceKey === coalesceKey &&
      now - last.at <= this.#coalesceMs
    ) {
      // Keep the OLDEST state in the run — undo should jump back past the whole drag,
      // not to its penultimate frame.
      this.#past[this.#past.length - 1] = { ...last, at: now };
      this.#future.length = 0;
      return;
    }

    this.#past.push({ state, label, coalesceKey, at: now });
    if (this.#past.length > this.#limit) this.#past.shift();
    this.#future.length = 0; // a new edit invalidates the redo branch
  }

  /** @param current the present state, pushed onto the redo stack. */
  undo(current: T): { state: T; label: string } | null {
    const entry = this.#past.pop();
    if (!entry) return null;
    this.#future.push({ ...entry, state: current });
    return { state: entry.state, label: entry.label };
  }

  redo(current: T): { state: T; label: string } | null {
    const entry = this.#future.pop();
    if (!entry) return null;
    this.#past.push({ ...entry, state: current });
    return { state: entry.state, label: entry.label };
  }

  clear(): void {
    this.#past.length = 0;
    this.#future.length = 0;
  }
}
