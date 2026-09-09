import { describe, expect, it } from 'vitest';
import { History } from './history.js';

const at = (t: { now: number }) => new History<string>({ coalesceMs: 400, now: () => t.now });

describe('undo and redo', () => {
  it('walks back and forward through states', () => {
    const h = new History<string>();
    h.record('v1', 'first');
    h.record('v2', 'second');
    expect(h.undo('v3')).toEqual({ state: 'v2', label: 'second' });
    expect(h.undo('v2')).toEqual({ state: 'v1', label: 'first' });
    expect(h.undo('v1')).toBeNull();
    expect(h.redo('v1')).toEqual({ state: 'v2', label: 'first' });
  });

  it('discards the redo branch once a new edit lands', () => {
    const h = new History<string>();
    h.record('v1', 'a');
    h.undo('v2');
    expect(h.canRedo).toBe(true);
    h.record('v1b', 'b');
    expect(h.canRedo).toBe(false);
  });

  it('exposes labels for the menu', () => {
    const h = new History<string>();
    expect(h.undoLabel).toBeNull();
    h.record('v1', 'Set width');
    expect(h.undoLabel).toBe('Set width');
  });

  it('drops the oldest states past the limit', () => {
    const h = new History<string>({ limit: 3 });
    for (let i = 0; i < 10; i++) h.record(`v${i}`, `edit ${i}`);
    expect(h.depth).toBe(3);
    expect(h.undo('now')!.state).toBe('v9');
  });
});

describe('coalescing', () => {
  it('collapses a rapid run of edits to the same target into one step', () => {
    // Dragging a slider must leave one undo step, not two hundred.
    const t = { now: 1000 };
    const h = at(t);
    h.record('start', 'Set width', 'param:width');
    for (let i = 0; i < 50; i++) {
      t.now += 10;
      h.record(`during-${i}`, 'Set width', 'param:width');
    }
    expect(h.depth).toBe(1);
    // Undo jumps back past the whole drag, not to its penultimate frame.
    expect(h.undo('end')!.state).toBe('start');
  });

  it('starts a new step once the window lapses', () => {
    const t = { now: 1000 };
    const h = at(t);
    h.record('a', 'Set width', 'param:width');
    t.now += 5000;
    h.record('b', 'Set width', 'param:width');
    expect(h.depth).toBe(2);
  });

  it('does not merge edits to different targets', () => {
    const t = { now: 1000 };
    const h = at(t);
    h.record('a', 'Set width', 'param:width');
    t.now += 10;
    h.record('b', 'Set depth', 'param:depth');
    expect(h.depth).toBe(2);
  });

  it('never merges when no key is given', () => {
    const t = { now: 1000 };
    const h = at(t);
    h.record('a', 'Add feature');
    t.now += 1;
    h.record('b', 'Add feature');
    expect(h.depth).toBe(2);
  });

  it('clears the redo branch when coalescing', () => {
    const t = { now: 1000 };
    const h = at(t);
    h.record('a', 'Set width', 'param:width');
    h.undo('b');
    expect(h.canRedo).toBe(true);
    h.record('c', 'Set width', 'param:width');
    expect(h.canRedo).toBe(false);
  });
});
