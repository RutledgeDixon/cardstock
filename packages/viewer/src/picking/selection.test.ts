import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asBodyId, type EntityRef } from '@cardstock/types';
import { SelectionManager } from './selection.js';

const B = asBodyId('body-1');
const face = (i: number): EntityRef => ({ bodyId: B, kind: 'face', index: i });
const edge = (i: number): EntityRef => ({ bodyId: B, kind: 'edge', index: i });

let sel: SelectionManager;
beforeEach(() => { sel = new SelectionManager(); });

describe('click', () => {
  it('replaces the selection on a plain click', () => {
    sel.click(face(1));
    sel.click(face(2));
    expect(sel.selected).toEqual([face(2)]);
  });

  it('adds and removes on additive click', () => {
    sel.click(face(1));
    sel.click(face(2), true);
    expect(sel.selected).toHaveLength(2);
    sel.click(face(1), true); // toggle the first back off
    expect(sel.selected).toEqual([face(2)]);
  });

  it('clears when clicking empty space', () => {
    sel.click(face(1));
    sel.click(null);
    expect(sel.isEmpty).toBe(true);
  });

  it('keeps the selection when additive-clicking empty space', () => {
    // Missing the model with shift held should not throw away the work so far.
    sel.click(face(1));
    sel.click(null, true);
    expect(sel.selected).toEqual([face(1)]);
  });
});

describe('change notifications', () => {
  it('does not fire when re-hovering the same entity', () => {
    const spy = vi.fn();
    sel.subscribe(spy);
    sel.setHover(face(1));
    sel.setHover({ ...face(1) }); // equal by value, different object
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does not fire when re-clicking the sole selected entity', () => {
    sel.click(face(1));
    const spy = vi.fn();
    sel.subscribe(spy);
    sel.click(face(1));
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not fire when clearing an already-empty selection', () => {
    const spy = vi.fn();
    sel.subscribe(spy);
    sel.clear();
    expect(spy).not.toHaveBeenCalled();
  });

  it('unsubscribes', () => {
    const spy = vi.fn();
    sel.subscribe(spy)();
    sel.click(face(1));
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('filter', () => {
  it('cycles face -> edge -> vertex -> body -> face', () => {
    const seen = [sel.filter];
    for (let i = 0; i < 4; i++) { sel.cycleFilter(); seen.push(sel.filter); }
    expect(seen).toEqual(['face', 'edge', 'vertex', 'body', 'face']);
  });

  it('cycles backwards', () => {
    sel.cycleFilter(-1);
    expect(sel.filter).toBe('body');
  });

  it('drops entities the new filter cannot admit', () => {
    sel.click(face(1));
    sel.click(edge(3), true);
    sel.setFilter('edge');
    expect(sel.selected).toEqual([edge(3)]);
  });

  it('clears an incompatible hover', () => {
    sel.setHover(face(1));
    sel.setFilter('edge');
    expect(sel.hover).toBeNull();
  });
});

describe('indicesByBody', () => {
  it('groups selected indices per body for the shaders', () => {
    const other = asBodyId('body-2');
    sel.click(face(1));
    sel.click(face(4), true);
    sel.click({ bodyId: other, kind: 'face', index: 2 }, true);
    sel.click(edge(9), true);
    const grouped = sel.indicesByBody('face');
    expect(grouped.get('body-1')).toEqual([1, 4]);
    expect(grouped.get('body-2')).toEqual([2]);
    expect(grouped.has('edge')).toBe(false);
  });
});
