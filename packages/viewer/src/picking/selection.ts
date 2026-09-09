import {
  ENTITY_KINDS,
  type EntityKind,
  type EntityRef,
  entityRefEquals,
  entityRefKey,
} from '@cardstock/types';

/**
 * Hover and selection state.
 *
 * Pure — no three.js, no DOM — because selection semantics (what does shift-click do at
 * the end of a range? does changing the filter drop incompatible entities?) are exactly
 * the kind of thing that is easy to get subtly wrong and cheap to pin down in tests.
 *
 * The filter decides what the pointer can hit. Cycling it with Tab is how you reach an
 * edge that sits behind a face.
 */
export type SelectionListener = (state: SelectionSnapshot) => void;

export interface SelectionSnapshot {
  readonly hover: EntityRef | null;
  readonly selected: readonly EntityRef[];
  readonly filter: EntityKind;
}

export class SelectionManager {
  #hover: EntityRef | null = null;
  #selected: EntityRef[] = [];
  #filter: EntityKind = 'face';
  #listeners = new Set<SelectionListener>();

  get hover(): EntityRef | null { return this.#hover; }
  get selected(): readonly EntityRef[] { return this.#selected; }
  get filter(): EntityKind { return this.#filter; }
  get isEmpty(): boolean { return this.#selected.length === 0; }

  subscribe(fn: SelectionListener): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #emit(): void {
    const snapshot: SelectionSnapshot = {
      hover: this.#hover,
      selected: [...this.#selected],
      filter: this.#filter,
    };
    for (const fn of this.#listeners) fn(snapshot);
  }

  setHover(ref: EntityRef | null): void {
    if (entityRefEquals(this.#hover, ref)) return; // no churn on every mouse move
    this.#hover = ref;
    this.#emit();
  }

  isSelected(ref: EntityRef): boolean {
    return this.#selected.some((r) => entityRefEquals(r, ref));
  }

  /**
   * Click semantics: plain click replaces the selection; additive click toggles.
   * Toggling (rather than only adding) is what lets you undo a mis-click without
   * starting the whole selection over.
   */
  click(ref: EntityRef | null, additive = false): void {
    if (ref === null) {
      if (!additive) this.clear();
      return;
    }
    if (additive) {
      const i = this.#selected.findIndex((r) => entityRefEquals(r, ref));
      if (i >= 0) this.#selected.splice(i, 1);
      else this.#selected.push(ref);
    } else {
      if (this.#selected.length === 1 && entityRefEquals(this.#selected[0]!, ref)) return;
      this.#selected = [ref];
    }
    this.#emit();
  }

  clear(): void {
    if (this.#selected.length === 0) return;
    this.#selected = [];
    this.#emit();
  }

  /**
   * Changing the filter drops anything it no longer admits, so the selection can never
   * contain entities the user cannot see highlighted. 'body' is a container kind and
   * admits everything.
   */
  setFilter(kind: EntityKind): void {
    if (this.#filter === kind) return;
    this.#filter = kind;
    const kept = this.#selected.filter((r) => r.kind === kind);
    const changed = kept.length !== this.#selected.length;
    this.#selected = kept;
    if (this.#hover && this.#hover.kind !== kind) this.#hover = null;
    void changed;
    this.#emit();
  }

  /** Tab cycles face -> edge -> vertex -> body -> face. */
  cycleFilter(direction: 1 | -1 = 1): void {
    const i = ENTITY_KINDS.indexOf(this.#filter);
    const next = ENTITY_KINDS[(i + direction + ENTITY_KINDS.length) % ENTITY_KINDS.length]!;
    this.setFilter(next);
  }

  /** Selected entities of one kind, as index lists per body — what the shaders want. */
  indicesByBody(kind: EntityKind): Map<string, number[]> {
    const out = new Map<string, number[]>();
    for (const r of this.#selected) {
      if (r.kind !== kind) continue;
      const list = out.get(r.bodyId);
      if (list) list.push(r.index);
      else out.set(r.bodyId, [r.index]);
    }
    return out;
  }

  keys(): Set<string> {
    return new Set(this.#selected.map(entityRefKey));
  }
}
